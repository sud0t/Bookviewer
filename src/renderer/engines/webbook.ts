/**
 * HTML books: a saved site (mdBook, Sphinx, Jupyter Book, MkDocs, ...) or a
 * single saved page, presented as a foliate-js "book" so that the reflow
 * engine can render it - one section per page, stitched into one scroll.
 *
 * The main process works out the page order and table of contents (see
 * src/main/webbook.ts). Here each page is fetched, stripped down to its
 * actual content - no site chrome, no scripts - and handed to the renderer.
 */
import {
  bookUrl,
  type Book,
  type Selector,
  type TocNode,
  type WebBookManifest,
} from '@shared/types'
import type { FoliateBook, FoliateTocItem, Resolved } from 'foliate-js/types'
import { anchorQuote, describeRange, rangeMatches } from '../annotations/anchor'
import { CFI, fromRange, toRange as cfiToRange } from './cfi'
import { ipc } from '../lib/ipc'
import { ReflowEngine, type Locator } from './epub'
import { preparePage, type Highlighter } from './webpage'
import type { Engine, EngineEvents } from './types'

const splitHref = (href: string): [string, string] => {
  const at = href.indexOf('#')
  return at < 0 ? [href, ''] : [href.slice(0, at), href.slice(at + 1)]
}

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function fragmentOf(doc: Document, id: string): Element | null {
  if (!id) return null
  return doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`)
}

/** Normalizes "a/b/../c.html" style paths; null if it climbs out of the root. */
function normalizePath(path: string): string | null {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(part)
  }
  return out.join('/')
}

export function makeWebBook(
  bookId: number,
  manifest: WebBookManifest,
  highlight?: Highlighter,
): FoliateBook {
  const { pages, generator } = manifest
  const indexOf = new Map(pages.map((page, index) => [page.href, index]))
  const prepared = new Map<number, Promise<string>>()
  const urls = new Map<number, Promise<string>>()

  /** Finds the page a root-relative path refers to, allowing for directory-style URLs. */
  const lookup = (path: string): string | null => {
    const clean = path.replace(/\/$/, '')
    const candidates = clean ? [clean, `${clean}/index.html`, `${clean}.html`] : ['index.html']
    return candidates.find(candidate => indexOf.has(candidate)) ?? null
  }

  const prepare = (index: number): Promise<string> => {
    let html = prepared.get(index)
    if (!html) {
      const url = bookUrl(bookId, pages[index].href)
      html = fetch(url).then(async response => {
        if (!response.ok) throw new Error(`${pages[index].href}: ${response.status}`)
        return preparePage(await response.text(), url, generator, highlight)
      })
      prepared.set(index, html)
      // Keep only the most recent pages; a search walks the whole book.
      if (prepared.size > 24) prepared.delete(prepared.keys().next().value!)
      html.catch(() => prepared.delete(index))
    }
    return html
  }

  const convert = (nodes: TocNode[]): FoliateTocItem[] =>
    nodes.map(node => ({
      label: node.label,
      href: node.href,
      subitems: node.children.length ? convert(node.children) : null,
    }))

  const book: FoliateBook = {
    sections: pages.map((page, index) => ({
      id: page.href,
      size: page.size,
      linear: 'yes',
      load() {
        // one blob URL per page, however many callers ask at once
        let url = urls.get(index)
        if (!url) {
          url = prepare(index).then(html =>
            URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })),
          )
          urls.set(index, url)
          url.catch(() => urls.delete(index))
        }
        return url
      },
      unload() {
        void urls.get(index)?.then(url => URL.revokeObjectURL(url), () => {})
        urls.delete(index)
      },
      async createDocument() {
        return new DOMParser().parseFromString(await prepare(index), 'text/html')
      },
      /** Turns a link as written in this page into a root-relative one. */
      resolveHref(href: string) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href
        const [path, hash] = splitHref(href)
        if (!path) return hash ? `${page.href}#${hash}` : page.href
        if (path.startsWith('/')) return href
        const directory = page.href.includes('/') ? page.href.slice(0, page.href.lastIndexOf('/') + 1) : ''
        const normalized = normalizePath(directory + safeDecode(path.replace(/\?.*$/, '')))
        const target = normalized == null ? null : lookup(normalized)
        if (!target) return href
        return hash ? `${target}#${hash}` : target
      },
    })),
    dir: 'ltr',
    toc: convert(manifest.toc),
    metadata: {
      title: manifest.title,
      author: manifest.author,
      language: manifest.language,
    },
    resolveHref(href: string): Resolved | null {
      const [path, hash] = splitHref(href)
      const index = indexOf.get(safeDecode(path)) ?? indexOf.get(path)
      if (index == null) return null
      const id = safeDecode(hash)
      return { index, anchor: doc => (id ? (fragmentOf(doc, id) ?? 0) : 0) }
    },
    isExternal: href => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'),
    splitTOCHref: href => {
      const [path, hash] = splitHref(href ?? '')
      return [path, safeDecode(hash)]
    },
    getTOCFragment: (doc, id) => fragmentOf(doc, String(id ?? '')),
    destroy() {
      for (const url of urls.values()) void url.then(u => URL.revokeObjectURL(u), () => {})
      urls.clear()
      prepared.clear()
    },
  }
  return book
}

interface WebLocation {
  href: string
  cfi: string | null
}

/**
 * Locations and anchors for HTML books are keyed by page path rather than
 * by spine position, so they survive the site being re-saved with pages
 * added or reordered; within the page a CFI is tried first, then the text.
 */
export function webLocator(manifest: WebBookManifest): Locator {
  const indexOf = new Map(manifest.pages.map((page, index) => [page.href, index]))
  const toRange = (doc: Document, cfi: string): Range | null => {
    try {
      return cfiToRange(doc, CFI.parse(cfi))
    } catch {
      return null
    }
  }
  return {
    toLocation(index, range) {
      const location: WebLocation = {
        href: manifest.pages[index].href,
        cfi: range ? fromRange(range) : null,
      }
      return JSON.stringify(location)
    },
    fromLocation(location) {
      if (!location.startsWith('{')) return null
      let parsed: WebLocation
      try {
        parsed = JSON.parse(location)
      } catch {
        return null
      }
      const index = indexOf.get(parsed.href)
      if (index == null) return null
      const { cfi } = parsed
      return { index, anchor: doc => (cfi ? (toRange(doc, cfi) ?? 0) : 0) }
    },
    toSelector(index, range): Selector | null {
      const doc = range.startContainer.ownerDocument!
      const described = describeRange(doc.body, range)
      if (!described) return null
      return {
        type: 'web',
        href: manifest.pages[index].href,
        cfi: fromRange(range),
        quote: described.quote,
        position: described.position,
      }
    },
    fromSelector(selector) {
      if (selector.type !== 'web') return null
      const index = indexOf.get(selector.href)
      if (index == null) return null
      return {
        index,
        anchor: doc => {
          const range = toRange(doc, selector.cfi)
          if (range && rangeMatches(range, selector.quote)) return range
          return anchorQuote(doc.body, selector.quote, selector.position.start)
        },
      }
    },
  }
}

export async function openWebBook(book: Book, events: EngineEvents): Promise<Engine> {
  const manifest = await ipc.invoke('books:manifest', book.id)
  if (!manifest?.pages.length) throw new Error('This HTML book has no readable pages')
  const { default: hljs } = await import('highlight.js/lib/common')
  const highlight: Highlighter = (code, language) => {
    if (!hljs.getLanguage(language)) return null
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    } catch {
      return null
    }
  }
  return new ReflowEngine(makeWebBook(book.id, manifest, highlight), events, {
    locator: webLocator(manifest),
  })
}
