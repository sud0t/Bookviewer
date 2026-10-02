/**
 * Reads OPDS catalogs - both the Atom-based 1.x format (through foliate-js's
 * converter) and OPDS 2.0 JSON - into one simple shape for the browser UI.
 */
import type { OpdsResponse } from '@shared/types'
import { SYMBOL, getFeed, getPublication } from 'foliate-js/opds.js'

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
  if (isJson) raw = JSON.parse(response.body) as RawGroup
  else {
    const doc = new DOMParser().parseFromString(response.body, 'application/xml')
    if (doc.querySelector('parsererror')) throw new Error('This is not an OPDS catalog')
    const root = doc.documentElement
    if (root.localName === 'entry')
      raw = { metadata: {}, publications: [getPublication(root) as RawPublication] }
    else if (root.localName === 'feed') raw = getFeed(doc) as RawGroup
    else throw new Error('This is not an OPDS catalog')
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
      acquisitions,
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
