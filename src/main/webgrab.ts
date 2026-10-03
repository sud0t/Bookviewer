/**
 * Saves a book that lives on the web into a library folder: the page at a
 * URL and, for a whole book, the pages of the same site it links to, with
 * their pictures and stylesheets. What lands on disk is an ordinary saved
 * site, which the scanner (webbook.ts) then reads like any other.
 *
 * Kept free of Electron imports (the fetch to use is passed in) so that it
 * can be tested against a made-up site.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { load } from 'cheerio'
import { safeJoin, sanitizeFilename } from './util'

export type GrabScope = 'site' | 'page'
export type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

export interface GrabProgress {
  /** Pages and files fetched so far, of those known about. */
  done: number
  total: number
  /** What is being fetched now. */
  label: string
}

export type GrabResult =
  /** A site was saved; `path` is its directory. */
  | { kind: 'site'; path: string; title: string; pages: number }
  /** The address is a file (a PDF, an EPUB, ...), not a page: it is to be downloaded as it is. */
  | { kind: 'file'; contentType: string }

const MAX_PAGES = 600
const MAX_PAGE_BYTES = 15 * 1024 * 1024
const MAX_ASSET_BYTES = 25 * 1024 * 1024
const MAX_TOTAL_BYTES = 800 * 1024 * 1024
const TIMEOUT_MS = 30_000
const PAGE_WORKERS = 4
const ASSET_WORKERS = 6
const HEADERS = { 'user-agent': 'BookViewer/0.1 (desktop e-book reader; saving a page to read offline)' }

/** Links that are certainly not pages of a book. */
const NOT_A_PAGE =
  /\.(pdf|epub|mobi|azw3?|zip|gz|tgz|bz2|xz|7z|rar|png|jpe?g|gif|webp|svg|ico|bmp|avif|mp[34]|m4[av]|webm|ogg|wav|css|js|mjs|json|xml|rss|atom|txt|csv|py|ipynb|exe|dmg|deb|rpm|iso|woff2?|ttf|otf)$/i

export class GrabError extends Error {}

/**
 * A machine on the reader's own network (or this one), named outright. A
 * page out on the web has no business making the app fetch from there.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Reads a response body, giving up (null) as soon as it is larger than `limit`. */
async function readLimited(response: Response, limit: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) return null
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

const isHtml = (type: string): boolean => /^(text\/html|application\/xhtml\+xml)\b/i.test(type.trim())

function decode(bytes: Uint8Array, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  // (the declaration sits in the first bytes, which are ASCII in any encoding that matters)
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const fromMeta = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head)?.[1]
  for (const label of [fromHeader, fromMeta, 'utf-8']) {
    if (!label) continue
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      // an encoding this runtime does not know: try the next guess
    }
  }
  return new TextDecoder().decode(bytes)
}

/** One path segment, made safe to be a file name. */
const segment = (name: string): string => {
  let decoded = name
  try {
    decoded = decodeURIComponent(name)
  } catch {
    // keep it as written
  }
  return sanitizeFilename(decoded).replace(/^\.+/, '').slice(0, 120) || '_'
}

/** The file name a query string adds, so that `page?id=1` and `page?id=2` stay apart. */
const querySuffix = (search: string): string =>
  search ? '_' + search.slice(1).replace(/[^\w.-]+/g, '_').slice(0, 60) : ''

function relativeLink(from: string, to: string): string {
  const link = posix.relative(posix.dirname(from), to) || posix.basename(to)
  return link.split('/').map(encodeURIComponent).join('/')
}

export async function grabUrl(
  options: {
    url: string
    /** The library folder to save into; it must exist. */
    folder: string
    scope: GrabScope
    signal?: AbortSignal
    onProgress?(progress: GrabProgress): void
  },
  fetchImpl: Fetch,
): Promise<GrabResult> {
  const { folder, scope, signal, onProgress } = options
  let start: URL
  try {
    start = new URL(options.url.trim())
  } catch {
    throw new GrabError('That is not a web address. It should look like https://example.com/book/')
  }
  if (start.protocol !== 'http:' && start.protocol !== 'https:')
    throw new GrabError('Only http:// and https:// addresses can be saved.')
  start.hash = ''

  let total = 0
  const get = async (url: string, limit: number): Promise<{ bytes: Uint8Array; type: string; url: string } | null> => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: HEADERS })
      if (!response.ok) return null
      const bytes = await readLimited(response, limit)
      if (!bytes) {
        controller.abort()
        return null
      }
      total += bytes.length
      if (total > MAX_TOTAL_BYTES) throw new GrabError('This site is too large to save (over 800 MB).')
      return { bytes, type: response.headers.get('content-type') ?? '', url: response.url || url }
    } catch (error) {
      if (error instanceof GrabError) throw error
      return null
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  const cancelled = () => {
    if (signal?.aborted) throw new GrabError('Cancelled')
  }

  /* ---------- the first page decides what this is ---------- */

  onProgress?.({ done: 0, total: 1, label: start.href })
  const probe = new AbortController()
  const stop = () => probe.abort()
  signal?.addEventListener('abort', stop, { once: true })
  const probeTimer = setTimeout(stop, TIMEOUT_MS)
  let first: { bytes: Uint8Array; type: string; url: string }
  try {
    let response: Response
    try {
      response = await fetchImpl(start.href, { signal: probe.signal, headers: HEADERS })
    } catch {
      cancelled()
      throw new GrabError(`Could not reach ${start.host}. Check the address and your connection.`)
    }
    if (!response.ok)
      throw new GrabError(`${start.host} answered with an error (${response.status}) for that address.`)
    const type = response.headers.get('content-type') ?? ''
    if (!isHtml(type)) {
      // not a page: leave the download to the caller, which streams it to disk
      probe.abort()
      return { kind: 'file', contentType: type }
    }
    const bytes = await readLimited(response, MAX_PAGE_BYTES)
    if (!bytes) throw new GrabError('That page is too large to save.')
    first = { bytes, type, url: response.url || start.href }
  } finally {
    clearTimeout(probeTimer)
    signal?.removeEventListener('abort', stop)
  }
  // (after a redirect, links are relative to where we ended up)
  const home = new URL(first.url)
  home.hash = ''
  const prefix = home.pathname.slice(0, home.pathname.lastIndexOf('/') + 1)
  const inScope = (url: URL): boolean =>
    url.origin === home.origin && url.pathname.startsWith(prefix) && !NOT_A_PAGE.test(url.pathname)
  const keyOf = (url: URL): string => url.origin + url.pathname + url.search

  /* ---------- which pages, and where each goes ---------- */

  const pages = new Map<string, { url: URL; path: string; html?: string }>()
  const taken = new Set<string>()
  const unique = (path: string): string => {
    const dot = path.lastIndexOf('.')
    let candidate = path
    for (let n = 1; taken.has(candidate.toLowerCase()); n++)
      candidate = `${path.slice(0, dot)}-${n}${path.slice(dot)}`
    taken.add(candidate.toLowerCase())
    return candidate
  }
  const pagePath = (url: URL): string => {
    const parts = url.pathname.slice(prefix.length).split('/').map(part => (part ? segment(part) : ''))
    let name = parts.pop() ?? ''
    if (!name) name = 'index.html'
    else if (!/\.x?html?$/i.test(name)) name += querySuffix(url.search) + '.html'
    else if (url.search) name = name.replace(/(\.x?html?)$/i, querySuffix(url.search) + '$1')
    return unique([...parts.filter(Boolean), name].join('/'))
  }
  const addPage = (url: URL): boolean => {
    const key = keyOf(url)
    if (pages.has(key) || pages.size >= MAX_PAGES) return false
    pages.set(key, { url, path: pagePath(url) })
    return true
  }
  // The page asked for is the book's front door, whatever it is called.
  pages.set(keyOf(home), { url: home, path: unique('index.html') })
  if (keyOf(start) !== keyOf(home)) pages.set(keyOf(start), pages.get(keyOf(home))!)

  const linksOf = (html: string, base: URL, selector: string): URL[] => {
    const $ = load(html)
    const found: URL[] = []
    $(selector).each((_, element) => {
      const href = $(element).attr('href')
      if (!href || /^(#|mailto:|javascript:|tel:|data:)/i.test(href.trim())) return
      try {
        const url = new URL(href, base)
        url.hash = ''
        if (inScope(url)) found.push(url)
      } catch {
        // not a link we can follow
      }
    })
    return found
  }

  const firstHtml = decode(first.bytes, first.type)
  pages.get(keyOf(home))!.html = firstHtml
  let queue: URL[] = []
  if (scope === 'site') {
    queue = linksOf(firstHtml, home, 'a[href]').filter(addPage)
    // mdBook keeps its table of contents in a file of its own, loaded by a script.
    if (/mdBook/i.test(firstHtml.slice(0, 4000))) {
      const toc = new URL('toc.html', home)
      if (addPage(toc)) queue.unshift(toc)
    }
  }

  let done = 1
  const report = (label: string) => onProgress?.({ done, total: pages.size + assets.size, label })
  const assets = new Map<string, { url: URL; path: string }>()

  const fetchPage = async (url: URL): Promise<void> => {
    cancelled()
    const page = pages.get(keyOf(url))!
    const got = await get(url.href, MAX_PAGE_BYTES)
    done++
    report(url.pathname)
    if (!got || !isHtml(got.type)) {
      pages.delete(keyOf(url))
      return
    }
    page.html = decode(got.bytes, got.type)
    // Follow what a page calls "next" (a book whose contents page only links
    // to its first chapter) and, for mdBook, everything its contents list.
    const follow = url.pathname.endsWith('/toc.html') ? 'a[href]' : 'a[rel~="next"], link[rel~="next"]'
    for (const next of linksOf(page.html, new URL(got.url), follow)) if (addPage(next)) queue.push(next)
  }
  const drain = async <T>(items: () => T | undefined, work: (item: T) => Promise<void>, workers: number) => {
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let item = items(); item !== undefined; item = items()) await work(item)
      }),
    )
  }
  // (twice over: pages found while the workers ran out of work get a second round)
  while (queue.length) await drain(() => queue.shift(), fetchPage, PAGE_WORKERS)
  cancelled()

  /* ---------- rewrite each page to work from disk ---------- */

  const assetPath = (url: URL): string => {
    const parts = url.pathname.split('/').filter(Boolean).map(segment)
    let name = parts.pop() ?? 'file'
    if (url.search) {
      const dot = name.lastIndexOf('.')
      name = dot > 0 ? name.slice(0, dot) + querySuffix(url.search) + name.slice(dot) : name + querySuffix(url.search)
    }
    return unique(['_assets', segment(url.host), ...parts, name].join('/'))
  }
  const assetFor = (raw: string | undefined, base: URL): string | null => {
    if (!raw || /^(data:|blob:|about:|javascript:)/i.test(raw.trim())) return null
    let url: URL
    try {
      url = new URL(raw.trim(), base)
    } catch {
      return null
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    // (a book served from this machine may of course use its own pictures)
    if (isPrivateHost(url.hostname) && url.hostname !== home.hostname) return null
    url.hash = ''
    let asset = assets.get(url.href)
    if (!asset) {
      asset = { url, path: assetPath(url) }
      assets.set(url.href, asset)
    }
    return asset.path
  }

  const output = new Map<string, string>()
  let title = ''
  const seen = new Set<string>()
  for (const page of pages.values()) {
    if (page.html == null || seen.has(page.path)) continue
    seen.add(page.path)
    const $ = load(page.html)
    if (page.path === 'index.html') {
      title = $('title').first().text().replace(/\s+/g, ' ').trim()
      // "Book - Book", as sites that append their own name to every title end up with
      const halves = /^(.+?)\s+[-|–—:]\s+(.+)$/.exec(title)
      if (halves && halves[1].toLowerCase() === halves[2].toLowerCase()) title = halves[1]
    }
    const base = (() => {
      try {
        return new URL($('base[href]').attr('href') ?? '', page.url)
      } catch {
        return page.url
      }
    })()
    $('script, noscript, base, meta[http-equiv="refresh" i], meta[charset], meta[http-equiv="content-type" i]').remove()
    $('link').each((_, element) => {
      const rel = ($(element).attr('rel') ?? '').toLowerCase()
      if (!/\b(stylesheet|next|prev|previous)\b/.test(rel)) $(element).remove()
    })
    $('head').prepend('<meta charset="utf-8">')
    $('a[href], link[rel~="next" i], link[rel~="prev" i], link[rel~="previous" i]').each((_, element) => {
      const href = $(element).attr('href')!.trim()
      if (href.startsWith('#') || /^(mailto:|javascript:|tel:|data:)/i.test(href)) return
      try {
        const url = new URL(href, base)
        const hash = url.hash
        url.hash = ''
        const target = pages.get(keyOf(url))
        $(element).attr('href', target?.html != null ? relativeLink(page.path, target.path) + hash : url.href + hash)
      } catch {
        // leave what cannot be parsed
      }
    })
    $('link[rel~="stylesheet" i]').each((_, element) => {
      const path = assetFor($(element).attr('href'), base)
      if (path) $(element).attr('href', relativeLink(page.path, path))
      else $(element).remove()
    })
    $('img, source, video, audio').each((_, element) => {
      const node = $(element)
      // pictures loaded by a script when scrolled to keep their address in a data attribute
      const lazy = node.attr('data-src') ?? node.attr('data-original') ?? node.attr('data-lazy-src')
      const src = node.attr('src')
      const raw = lazy && (!src || /^data:|placeholder|blank|spacer/i.test(src)) ? lazy : src
      for (const attribute of ['srcset', 'data-srcset', 'data-src', 'data-original', 'data-lazy-src', 'loading'])
        node.removeAttr(attribute)
      if (element.tagName === 'video' || element.tagName === 'audio') {
        // not saved: point at the original so that it at least links somewhere
        if (src) node.attr('src', (() => { try { return new URL(src, base).href } catch { return src } })())
        return
      }
      if (!raw) return
      const path = assetFor(raw, base)
      if (path) node.attr('src', relativeLink(page.path, path))
    })
    output.set(page.path, $.html())
  }

  /* ---------- write it all out ---------- */

  const name = sanitizeFilename(title).slice(0, 100) || segment(home.host)
  let target = join(folder, name)
  for (let n = 2; existsSync(target); n++) target = join(folder, `${name} (${n})`)
  // Under a name the scanner skips until everything is there.
  const partial = join(folder, `.${name}.part`)
  await rm(partial, { recursive: true, force: true })
  const put = async (relative: string, data: string | Uint8Array) => {
    const file = safeJoin(partial, relative)
    if (!file) return
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, data)
  }
  try {
    await mkdir(partial, { recursive: true })
    for (const [path, html] of output) await put(path, html)
    const pending = [...assets.values()]
    await drain(
      () => pending.shift(),
      async asset => {
        cancelled()
        const got = await get(asset.url.href, MAX_ASSET_BYTES)
        done++
        report(asset.url.pathname)
        // (a page served where a picture was expected is of no use)
        if (got && !isHtml(got.type)) await put(asset.path, got.bytes)
      },
      ASSET_WORKERS,
    )
    cancelled()
    await rename(partial, target)
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
  return { kind: 'site', path: target, title: title || home.host, pages: output.size }
}
