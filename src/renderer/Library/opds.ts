/**
 * Reads OPDS catalogs - both the Atom-based 1.x format (through foliate-js's
 * converter) and OPDS 2.0 JSON - into one simple shape for the browser UI.
 */
import type { OpdsResponse } from '@shared/types'
import { SYMBOL, getFeed, getPublication } from 'foliate-js/opds.js'
import { withoutIpcPrefix } from '../lib/ipc'

export interface OpdsNavItem {
  title: string
  href: string
  summary: string
}

export interface OpdsAcquisition {
  href: string
  /** "EPUB", "PDF", ... */
  label: string
}

export interface OpdsPublication {
  title: string
  author: string
  summary: string
  cover: string | null
  /** The format to offer first (EPUB, else PDF) comes first. */
  acquisitions: OpdsAcquisition[]
  /** A page with more about the book, when the feed links to one. */
  details: string | null
}

export interface OpdsGroup {
  title: string
  href: string | null
  navigation: OpdsNavItem[]
  publications: OpdsPublication[]
}

export interface OpdsFeed {
  title: string
  url: string
  groups: OpdsGroup[]
  next: string | null
  search: { href: string; kind: 'opensearch' | 'template' } | null
}

/** Media types we can add to the library, with the label to show. */
const FORMATS: Record<string, string> = {
  'application/epub+zip': 'EPUB',
  'application/pdf': 'PDF',
  'application/x-mobipocket-ebook': 'MOBI',
  'application/vnd.amazon.mobi8-ebook': 'AZW3',
  'application/x-fictionbook+xml': 'FB2',
  'application/x-zip-compressed-fb2': 'FB2',
  'application/vnd.comicbook+zip': 'CBZ',
  'application/x-cbz': 'CBZ',
}

interface RawLink {
  rel?: string | string[] | null
  href?: string | null
  type?: string | null
  title?: string | null
  templated?: boolean
}

interface RawPublication {
  metadata?: Record<string | symbol, unknown>
  links?: RawLink[]
  images?: RawLink[]
}

interface RawGroup {
  metadata?: { title?: string }
  links?: RawLink[]
  navigation?: (RawLink & Record<symbol, unknown>)[]
  publications?: RawPublication[]
  groups?: RawGroup[]
}

const relsOf = (link: RawLink): string[] => [link.rel ?? []].flat().filter(Boolean) as string[]

const mediaType = (type: string | null | undefined): string =>
  (type ?? '').split(';')[0].trim().toLowerCase()

function nameOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(nameOf).filter(Boolean).join(', ')
  if (typeof value === 'object') return nameOf((value as { name?: unknown }).name)
  return ''
}

/** The address answered, but not with a catalog. */
export class NotCatalogError extends Error {
  constructor() {
    super('not a catalog')
    this.name = 'NotCatalogError'
  }
}

/** Formats in the order to offer them: EPUB reads best here, then PDF, then the rest as listed. */
export function preferredFirst(acquisitions: OpdsAcquisition[]): OpdsAcquisition[] {
  const rank = (label: string) => (label === 'EPUB' ? 0 : label === 'PDF' ? 1 : 2)
  return acquisitions
    .map((acquisition, index) => ({ acquisition, index }))
    .sort((a, b) => rank(a.acquisition.label) - rank(b.acquisition.label) || a.index - b.index)
    .map(item => item.acquisition)
}

const stripHtml = (html: string): string =>
  new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() ?? ''

export function parseFeed(response: OpdsResponse): OpdsFeed {
  const resolve = (href: string | null | undefined): string | null => {
    if (!href) return null
    try {
      return new URL(href, response.url).href
    } catch {
      return null
    }
  }

  const isJson = /json/i.test(response.contentType) || response.body.trimStart().startsWith('{')
  let raw: RawGroup
  if (isJson) {
    try {
      raw = JSON.parse(response.body) as RawGroup
    } catch {
      throw new NotCatalogError()
    }
    const parts = ['metadata', 'links', 'navigation', 'publications', 'groups']
    if (!raw || typeof raw !== 'object' || !parts.some(part => part in raw)) throw new NotCatalogError()
  } else {
    const doc = new DOMParser().parseFromString(response.body, 'application/xml')
    if (doc.querySelector('parsererror')) throw new NotCatalogError()
    const root = doc.documentElement
    if (root.localName === 'entry')
      raw = { metadata: {}, publications: [getPublication(root) as RawPublication] }
    else if (root.localName === 'feed') raw = getFeed(doc) as RawGroup
    else throw new NotCatalogError()
  }

  const publication = (pub: RawPublication): OpdsPublication => {
    const metadata = pub.metadata ?? {}
    const acquisitions: OpdsAcquisition[] = []
    let details: string | null = null
    for (const link of pub.links ?? []) {
      const rels = relsOf(link)
      const href = resolve(link.href)
      if (!href) continue
      const acquisition = rels.find(rel => rel.startsWith('http://opds-spec.org/acquisition'))
      const free = acquisition && !/\/(buy|borrow|subscribe|sample)$/.test(acquisition)
      const label = FORMATS[mediaType(link.type)]
      if (free && label && !acquisitions.some(a => a.label === label)) acquisitions.push({ href, label })
      else if (!details && (rels.includes('alternate') || rels.includes('related')) && /html/.test(link.type ?? ''))
        details = href
    }
    const content = metadata[SYMBOL.CONTENT] as { value?: string; type?: string } | undefined
    const description = (metadata.description as string | undefined) ?? content?.value ?? ''
    return {
      title: nameOf(metadata.title) || 'Untitled',
      author: nameOf(metadata.author),
      summary: /<[a-z]/i.test(description) ? stripHtml(description) : description.trim(),
      cover: resolve(pub.images?.[0]?.href),
      acquisitions: preferredFirst(acquisitions),
      details,
    }
  }

  const group = (source: RawGroup, fallbackTitle: string): OpdsGroup => ({
    title: source.metadata?.title ?? fallbackTitle,
    href: resolve(source.links?.find(link => relsOf(link).includes('self'))?.href),
    navigation: (source.navigation ?? []).flatMap(item => {
      const href = resolve(item.href)
      return href
        ? [{ title: item.title ?? href, href, summary: (item[SYMBOL.SUMMARY] as string) ?? '' }]
        : []
    }),
    publications: (source.publications ?? []).map(publication),
  })

  const groups = [
    { ...group(raw, ''), href: null },
    ...(raw.groups ?? []).map(item => group(item, '')),
  ].filter(item => item.navigation.length || item.publications.length)

  const links = raw.links ?? []
  const next = links.find(link => relsOf(link).includes('next'))
  const searchLink = links.find(link => relsOf(link).includes('search'))
  let search: OpdsFeed['search'] = null
  if (searchLink?.href) {
    const templated = !!searchLink.templated || /\{.*\}/.test(searchLink.href)
    // A template is kept as written (resolving it would escape the braces).
    const href = templated ? searchLink.href : resolve(searchLink.href)
    if (href) search = { href, kind: templated ? 'template' : 'opensearch' }
  }

  return {
    title: (raw.metadata?.title ?? '').trim() || 'Catalog',
    url: response.url,
    groups,
    next: resolve(next?.href),
    search,
  }
}

/**
 * Fills in an OpenSearch description's template. Of the URLs a description
 * offers, the one returning a catalog is wanted, not the HTML results page.
 */
export function openSearchUrl(description: Document, terms: string): string | null {
  const urls = [...description.getElementsByTagName('*')].filter(el => el.localName === 'Url')
  const type = (el: Element) => (el.getAttribute('type') ?? '').toLowerCase()
  const url =
    urls.find(el => /opds/.test(type(el))) ??
    urls.find(el => /atom\+xml/.test(type(el))) ??
    urls.find(el => !/html/.test(type(el))) ??
    urls[0]
  const template = url?.getAttribute('template')
  if (!url || !template) return null
  const defaults: Record<string, string> = {
    count: '50',
    startIndex: url.getAttribute('indexOffset') ?? '1',
    startPage: url.getAttribute('pageOffset') ?? '1',
    language: '*',
    inputEncoding: 'UTF-8',
    outputEncoding: 'UTF-8',
  }
  return template.replace(/\{(?:[^}:]+:)?([^}?]+)\??\}/g, (_, name: string) =>
    encodeURIComponent(name === 'searchTerms' ? terms : (defaults[name] ?? '')),
  )
}

/** Builds the URL of a search for `terms` in the catalog a feed belongs to. */
export async function searchUrl(
  feed: OpdsFeed,
  terms: string,
  fetchText: (url: string) => Promise<OpdsResponse>,
): Promise<string | null> {
  const { search } = feed
  if (!search) return null
  const encoded = encodeURIComponent(terms)
  if (search.kind === 'template') {
    // "{?query}" (OPDS 2) and "{searchTerms}" (OpenSearch-in-Atom) forms
    const filled = search.href
      .replace(/\{\?([^}]+)\}/, (_, names: string) => `?${names.split(',')[0]}=${encoded}`)
      .replace(/\{searchTerms\??\}/g, encoded)
      .replace(/\{[^}]*\}/g, '')
    return new URL(filled, feed.url).href
  }
  const description = await fetchText(search.href)
  const doc = new DOMParser().parseFromString(description.body, 'application/xml')
  const filled = openSearchUrl(doc, terms)
  return filled ? new URL(filled, description.url).href : null
}

/** "m.gutenberg.org" - who a catalog address talks to, for messages. */
export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`).host
  } catch {
    return ''
  }
}

/** Two titles that a reader would call the same. */
export const sameTitle = (a: string, b: string): boolean =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Says what went wrong with a catalog request, and what to do about it, in a
 * sentence for the reader. `cause` is whatever was thrown: a network error
 * ("net::ERR_..."), the main process's "HTTP 404" / "timeout" / "too large" /
 * "not a book", or a feed that would not parse. `host` is who was asked.
 */
export function friendlyError(cause: unknown, host: string): string {
  const text = withoutIpcPrefix(cause instanceof Error ? cause.message : String(cause ?? ''))
  const who = host || 'the server'
  const Who = host || 'The server'
  const unreachable = `Can't reach ${who}. Check the address and your connection.`
  const notResponding = `${Who} isn't responding right now. Try again in a moment.`

  if (cause instanceof NotCatalogError || cause instanceof SyntaxError || /not an? (OPDS )?catalog/i.test(text))
    return "That address isn't a catalog. Check that it is the catalog's own address, not an ordinary web page."
  if (/not a book/i.test(text))
    return "That link doesn't lead to a book file. The catalog may need you to sign in on its website first."
  if (/too large/i.test(text)) return 'That is larger than BookViewer can load.'
  if (/Invalid URL|Only http and https/i.test(text))
    return "That doesn't look like a web address. It should start with https:// or http://."
  if (/Unknown library folder|ENOENT/.test(text))
    return "The folder to save into can't be found. Choose another one under “Save to”."
  if (/EACCES|EPERM|EROFS/.test(text))
    return "BookViewer isn't allowed to write to that folder. Choose another one under “Save to”."
  if (/ENOSPC/.test(text)) return 'The disk is full. Free some space and try again.'

  const network = /\bERR_[A-Z_]+/.exec(text)?.[0]
  if (network) {
    if (network === 'ERR_INTERNET_DISCONNECTED') return "You're offline. Check your connection and try again."
    if (/TIMED_OUT|EMPTY_RESPONSE/.test(network)) return notResponding
    if (/CERT|SSL/.test(network))
      return `The connection to ${who} isn't secure, so nothing was loaded. Check the address.`
    return unreachable
  }
  if (/timeout|timed out|aborted/i.test(text)) return notResponding

  const status = Number(/\bHTTP (\d{3})\b/.exec(text)?.[1] ?? /^(\d{3})\b/.exec(text)?.[1])
  if (status === 401 || status === 403 || status === 407)
    return "This catalog needs a sign-in, which BookViewer doesn't support yet."
  if (status === 404 || status === 410) return 'Nothing was found at that address.'
  if (status === 408 || status === 429 || status >= 500) return notResponding
  if (status >= 400) return `${Who} turned the request down (error ${status}).`

  return `Something went wrong while talking to ${who}. Try again in a moment.`
}

/**
 * The home directory the library folders live in, when they agree on one.
 * The UI has no other way to learn it; with folders under two different homes
 * (or none) paths are shown in full instead.
 */
export function homeOf(paths: string[]): string | null {
  const homes = new Set(paths.flatMap(path => /^\/(?:home\/[^/]+|root)(?=\/|$)/.exec(path)?.[0] ?? []))
  return homes.size === 1 ? [...homes][0] : null
}

/** "~/Books" for a path inside `home`; a long path keeps only its last two folders ("…/Shelves/Books"). */
export function shortenHome(path: string, home: string | null): string {
  const short = home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path
  const parts = short.split('/')
  return short.length > 40 && parts.length > 3 ? '…/' + parts.slice(-2).join('/') : short
}

/** "Books (~/Books)": a folder's name, then where it is, so that two "Books" can be told apart. */
export function folderLabel(path: string, home: string | null): string {
  const name = path.split('/').filter(Boolean).pop() ?? path
  return `${name} (${shortenHome(path, home)})`
}
