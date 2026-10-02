/**
 * Turns a saved HTML site (mdBook, Sphinx, Jupyter Book, MkDocs, ... or just a
 * folder of pages) into a "book": an ordered list of pages plus a table of
 * contents, read from the site's own navigation.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { load, type CheerioAPI } from 'cheerio'
import type { AnyNode, Element } from 'domhandler'
import {
  WEB_MANIFEST_VERSION,
  type TocNode,
  type WebBookManifest,
  type WebGenerator,
  type WebPage,
} from '@shared/types'

export const HTML_FILE = /\.x?html?$/i
const ENTRY_NAMES = ['index', 'toc', 'contents', 'content', 'main', 'default', 'start', 'home']
const MAX_PAGES = 20000
const MAX_DEPTH = 12

/** Directory names that never hold book pages. */
export const IGNORED_DIRS = new Set(['node_modules', '__pycache__', '__MACOSX'])

export interface DirListing {
  files: string[]
  dirs: string[]
}

export async function listDir(dir: string): Promise<DirListing> {
  const files: string[] = []
  const dirs: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { files, dirs }
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(join(dir, entry.name))
        isDir = target.isDirectory()
        isFile = target.isFile()
      } catch {
        continue
      }
    }
    if (isDir && !IGNORED_DIRS.has(entry.name)) dirs.push(entry.name)
    else if (isFile) files.push(entry.name)
  }
  files.sort(naturalCompare)
  dirs.sort(naturalCompare)
  return { files, dirs }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b)

const readHead = async (file: string, bytes = 16384): Promise<string> => {
  try {
    const buffer = await readFile(file)
    return buffer.subarray(0, bytes).toString('utf8')
  } catch {
    return ''
  }
}

/** The page a directory of HTML files should open on, if it has one. */
export function findEntry(files: string[]): string | null {
  const html = files.filter(name => HTML_FILE.test(name))
  if (!html.length) return null
  for (const stem of ENTRY_NAMES) {
    const match = html.find(name => name.toLowerCase().replace(HTML_FILE, '') === stem)
    if (match) return match
  }
  return html[0]
}

export interface Classification {
  /** A generator's fingerprints were found: this directory is a book root. */
  generator: WebGenerator | null
  /** Looks like it could be a book (an index page, or several pages). */
  candidate: boolean
  entry: string | null
}

export async function classifyDir(dir: string, listing: DirListing): Promise<Classification> {
  const files = new Set(listing.files)
  const dirs = new Set(listing.dirs)
  const html = listing.files.filter(name => HTML_FILE.test(name))
  const index = listing.files.find(name => /^index\.x?html?$/i.test(name)) ?? null
  const none: Classification = {
    generator: null,
    candidate: !!index || html.length >= 2,
    entry: findEntry(listing.files),
  }
  if (!index) return none

  const strong = (generator: WebGenerator): Classification => ({
    generator,
    candidate: true,
    entry: index,
  })
  const has = (pattern: RegExp) => listing.files.some(name => pattern.test(name))

  if (files.has('toc.html') && (has(/^book(-[0-9a-f]+)?\.js$/) || has(/^toc(-[0-9a-f]+)?\.js$/)))
    return strong('mdbook')
  if (files.has('objects.inv')) return strong('sphinx')
  if (files.has('searchindex.js') && dirs.has('_static')) return strong('sphinx')
  if (dirs.has('gitbook') && files.has('search_index.json')) return strong('gitbook')

  const head = await readHead(join(dir, index))
  if (/generated using mdBook/i.test(head)) return strong('mdbook')
  const generator =
    /name=["']?generator["']?[^>]{0,300}/i.exec(head)?.[0] ??
    /content=["'][^"'>]{0,300}["'][^>]{0,40}name=["']?generator/i.exec(head)?.[0] ??
    ''
  if (/mkdocs/i.test(generator)) return strong('mkdocs')
  if (/docusaurus/i.test(generator)) return strong('docusaurus')
  if (/sphinx|jupyter.?book/i.test(generator)) return strong('sphinx')
  if (/gitbook|honkit/i.test(generator)) return strong('gitbook')
  if (/mdbook/i.test(generator)) return strong('mdbook')
  if (files.has('searchindex.js') && has(/^genindex\.html$/)) return strong('sphinx')
  return none
}

/** Maps every HTML file under `root` (as a root-relative path) to its size. */
async function collectPages(root: string): Promise<Map<string, number>> {
  const pages = new Map<string, number>()
  const visited = new Set<string>()
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || pages.size >= MAX_PAGES) return
    const real = await realpath(join(root, rel)).catch(() => join(root, rel))
    if (visited.has(real)) return
    visited.add(real)
    const { files, dirs } = await listDir(join(root, rel))
    for (const name of files) {
      if (!HTML_FILE.test(name)) continue
      if (pages.size >= MAX_PAGES) return
      try {
        const info = await stat(join(root, rel, name))
        pages.set(posix.join(rel, name), info.size)
      } catch {
        // deleted while scanning
      }
    }
    for (const name of dirs) await walk(posix.join(rel, name), depth + 1)
  }
  await walk('', 0)
  return pages
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Resolves a link found in `from` (a root-relative page path) to a
 * root-relative page path plus fragment, or null if it leaves the book.
 */
export function resolveLink(
  href: string | undefined,
  from: string,
  pages: Map<string, number>,
): { path: string; hash: string } | null {
  if (!href) return null
  href = href.trim()
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null
  const hashAt = href.indexOf('#')
  // a bare "#" points at the page itself
  const hash = hashAt >= 0 && hashAt < href.length - 1 ? href.slice(hashAt) : ''
  let path = (hashAt >= 0 ? href.slice(0, hashAt) : href).replace(/\?.*$/, '')
  try {
    path = decodeURIComponent(path)
  } catch {
    // keep as is
  }
  if (path.startsWith('/')) return null
  let resolved = path ? posix.normalize(posix.join(posix.dirname(from), path)) : from
  if (resolved.startsWith('../') || resolved === '..') return null
  if (resolved === '.') resolved = ''
  resolved = resolved.replace(/\/$/, '')
  const candidates = [
    resolved,
    posix.join(resolved, 'index.html'),
    resolved + '.html',
    posix.join(resolved, 'index.htm'),
    resolved + '.htm',
  ]
  for (const candidate of candidates) if (pages.has(candidate)) return { path: candidate, hash }
  return null
}

const NAV_SELECTORS: Record<WebGenerator, string[]> = {
  mdbook: ['ol.chapter', '#sidebar', 'nav.sidebar'],
  sphinx: [
    'nav.bd-links',
    '.bd-sidebar-primary',
    '.wy-menu-vertical',
    '.sidebar-tree',
    '.toctree-wrapper',
    '.sphinxsidebarwrapper',
  ],
  mkdocs: ['nav.md-nav--primary', '.md-sidebar--primary', '.bs-sidebar', '.wy-menu-vertical'],
  docusaurus: ['nav.menu', '.theme-doc-sidebar-menu', 'aside nav'],
  gitbook: ['ul.summary', 'nav[role="navigation"]'],
  generic: [],
  single: [],
}

const GENERIC_NAV = [
  'nav#toc',
  '#toc',
  '.toc',
  'nav[role="doc-toc"]',
  '[role="navigation"]',
  'nav',
  '#sidebar',
  '.sidebar',
  'aside',
  '#contents',
  '.contents',
  '.menu',
]

type Resolve = (href: string | undefined) => { path: string; hash: string } | null

const MAX_LIST_DEPTH = 24
const isList = (node: AnyNode): node is Element =>
  node.type === 'tag' && (node.name === 'ul' || node.name === 'ol')

/**
 * Walks `root` without entering lists (or whatever `stop` matches), handing
 * back those boundary elements. Iterative: markup can nest absurdly deep.
 */
function shallow(
  root: Element,
  stop: (element: Element) => boolean,
  visit?: (node: AnyNode) => void,
): Element[] {
  const found: Element[] = []
  const stack: AnyNode[] = [...root.children].reverse()
  while (stack.length) {
    const node = stack.pop()!
    if (node.type === 'tag' && stop(node)) {
      found.push(node)
      continue
    }
    visit?.(node)
    if ('children' in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
  }
  return found
}

/** Reads a (possibly nested) `ul`/`ol` navigation list into a TOC tree. */
function parseList($: CheerioAPI, list: Element, resolve: Resolve, depth = 0): TocNode[] {
  const nodes: TocNode[] = []
  if (depth > MAX_LIST_DEPTH) return nodes
  for (const li of list.children) {
    if (li.type !== 'tag' || li.name !== 'li') continue
    // The item's own link and text are whatever is not inside a sub-list.
    let link: Element | null = null
    let own = ''
    const nested = shallow(li, isList, node => {
      if (node.type === 'text') own += node.data
      else if (!link && node.type === 'tag' && node.name === 'a' && node.attribs.href != null)
        if (clean($(node).text())) link = node
    })
    const children = nested.flatMap(el => parseList($, el, resolve, depth + 1))
    if (link) {
      const anchor: Element = link
      const target = resolve(anchor.attribs.href)
      nodes.push({
        label: clean($(anchor).text()),
        href: target ? target.path + target.hash : null,
        children,
      })
      continue
    }
    const label = clean(own)
    if (label) nodes.push({ label, href: null, children })
    // mdBook (older) puts a chapter's sub-list in a separate, unlabelled <li>.
    else if (children.length && nodes.length) nodes[nodes.length - 1].children.push(...children)
    else nodes.push(...children)
  }
  return nodes
}

function parseNav($: CheerioAPI, nav: Element, resolve: Resolve): TocNode[] {
  if (isList(nav)) return parseList($, nav, resolve)
  const nodes: TocNode[] = []
  let section: TocNode | null = null
  // Top-level lists, with the captions some themes put between them
  // ("Part I", "Appendices", ...).
  const isCaption = (el: Element) => {
    const classes = ` ${el.attribs.class ?? ''} `
    return (
      (el.name === 'p' && classes.includes(' caption ')) ||
      classes.includes(' caption-text ') ||
      classes.includes(' md-nav__title ')
    )
  }
  for (const el of shallow(nav, element => isList(element) || isCaption(element))) {
    if (isList(el)) {
      const items = parseList($, el, resolve)
      if (section) section.children.push(...items)
      else nodes.push(...items)
    } else {
      const label = clean($(el).text())
      if (!label) continue
      section = { label, href: null, children: [] }
      nodes.push(section)
    }
  }
  return nodes.filter(node => node.href || node.children.length)
}

const countLinks = (nodes: TocNode[]): number =>
  nodes.reduce((n, node) => n + (node.href ? 1 : 0) + countLinks(node.children), 0)

function findToc(
  $: CheerioAPI,
  generator: WebGenerator,
  resolve: Resolve,
  /** With no navigation element, fall back on the links in the page body. */
  fallback = true,
): TocNode[] {
  for (const selector of [...NAV_SELECTORS[generator], ...GENERIC_NAV]) {
    let best: TocNode[] = []
    for (const el of $(selector).toArray()) {
      if (el.type !== 'tag') continue
      const toc = parseNav($, el, resolve)
      if (countLinks(toc) > countLinks(best)) best = toc
    }
    if (countLinks(best) >= 2) return best
  }
  if (!fallback) return []
  // No navigation element: use the page's own links, in order.
  const seen = new Set<string>()
  const flat: TocNode[] = []
  for (const a of $('body a[href]').toArray()) {
    const target = resolve($(a).attr('href'))
    const label = clean($(a).text())
    if (!target || !label || seen.has(target.path)) continue
    seen.add(target.path)
    flat.push({ label, href: target.path + target.hash, children: [] })
  }
  return flat
}

const SEPARATORS = [' — ', ' – ', ' | ', ' · ', ' :: ', ' - ', ' « ', ' » ']

/** "Chapter 1 - My Book" -> "My Book"; the site name usually comes last. */
function siteTitle(title: string, generator: WebGenerator): string {
  for (const separator of SEPARATORS) {
    const at = title.lastIndexOf(separator)
    if (at > 0) {
      const tail = clean(title.slice(at + separator.length))
      if (tail) return generator === 'sphinx' ? tail.replace(/\s+documentation$/i, '') : tail
    }
  }
  return title
}

const BRAND_SELECTORS = [
  '.menu-title',
  '.logo__title',
  '.sidebar-brand-text',
  '.wy-side-nav-search > a',
  '.md-header__topic:first-child .md-ellipsis',
  '.navbar__title',
  '.book-summary .summary > li.header',
]

function extractTitle($: CheerioAPI, generator: WebGenerator, fallback: string): string {
  const siteName = clean($('meta[property="og:site_name"]').attr('content') ?? '')
  if (siteName) return siteName
  if (generator !== 'generic' && generator !== 'single') {
    for (const selector of BRAND_SELECTORS) {
      const text = clean($(selector).first().text())
      if (text) return text
    }
  }
  const title = clean($('head > title').first().text())
  if (title) return generator === 'single' ? title : siteTitle(title, generator)
  const heading = clean($('h1').first().text())
  return heading || fallback
}

const prettyName = (name: string): string =>
  clean(name.replace(HTML_FILE, '').replace(/[_]+/g, ' ')) || name

function isLocalImage(src: string | undefined): src is string {
  return !!src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')
}

function findCover($: CheerioAPI, entry: string): string | null {
  const resolve = (src: string): string | null => {
    let path = src.replace(/[?#].*$/, '')
    try {
      path = decodeURIComponent(path)
    } catch {
      // keep as is
    }
    if (path.startsWith('/')) return null
    const resolved = posix.normalize(posix.join(posix.dirname(entry), path))
    return resolved.startsWith('../') ? null : resolved
  }
  const og = $('meta[property="og:image"], meta[name="twitter:image"]').attr('content')
  if (isLocalImage(og)) {
    const path = resolve(og)
    if (path) return path
  }
  for (const img of $('body img[src]').toArray()) {
    const src = $(img).attr('src')
    if (!isLocalImage(src) || /\.svg$/i.test(src) || /logo|icon|badge|avatar/i.test(src)) continue
    const path = resolve(src)
    if (path) return path
  }
  return null
}

const flattenToc = (nodes: TocNode[]): TocNode[] =>
  nodes.flatMap(node => [node, ...flattenToc(node.children)])

/** Pages bigger than this are not parsed for navigation (they still display). */
const MAX_PARSE_BYTES = 16 * 1024 * 1024

async function parseFile(file: string): Promise<CheerioAPI> {
  let html = ''
  try {
    const info = await stat(file)
    if (info.size <= MAX_PARSE_BYTES) html = await readFile(file, 'utf8')
  } catch {
    // an unreadable page yields an empty document
  }
  return load(html)
}

const MAX_CHAIN = 5000
const CRAWL_BUDGET_MS = 25000

const NEXT_LINK = [
  'link[rel~="next"]',
  'a[rel~="next"]',
  'a.pagination-nav__link--next',
  'a.md-footer__link--next',
  'a.next-page',
].join(', ')

/** A page's own title, without the site name most generators append. */
function pageTitle($: CheerioAPI, fallback: string): string {
  const heading = clean($('h1').first().clone().find('a.headerlink, .headerlink').remove().end().text())
  if (heading) return heading.replace(/[¶#]\s*$/, '').trim()
  const title = clean($('head > title').first().text())
  for (const separator of SEPARATORS) {
    const at = title.indexOf(separator)
    if (at > 0) return title.slice(0, at)
  }
  return title || fallback
}

interface Crawl {
  /** Pages in reading order, following each page's "next" link. */
  order: string[]
  titles: Map<string, string>
}

/**
 * Walks the site the way a reader pressing "Next" would. Many themes only
 * list the top-level sections on the index page and reveal a section's
 * children in the sidebar once you are inside it, so along the way the
 * sub-trees each page shows are grafted into `toc`.
 */
async function crawl(
  root: string,
  entry: string,
  $entry: CheerioAPI,
  pages: Map<string, number>,
  generator: WebGenerator,
  toc: TocNode[],
): Promise<Crawl> {
  const order: string[] = []
  const titles = new Map<string, string>()
  const seen = new Set<string>()
  const deadline = Date.now() + CRAWL_BUDGET_MS

  const known = new Map<string, TocNode>()
  const register = (nodes: TocNode[]) => {
    for (const node of nodes) {
      const path = node.href?.replace(/#.*$/, '')
      if (path && !node.href!.includes('#') && !known.has(path)) known.set(path, node)
      register(node.children)
    }
  }
  register(toc)
  const graft = (nodes: TocNode[]) => {
    for (const node of nodes) {
      if (!node.children.length) continue
      const path = node.href?.replace(/#.*$/, '')
      const target = path && !node.href!.includes('#') ? known.get(path) : undefined
      if (target && target !== node && !target.children.length) {
        target.children = node.children
        register(node.children)
      } else graft(node.children)
    }
  }

  let current: string | null = entry
  while (current && !seen.has(current) && order.length < MAX_CHAIN && Date.now() < deadline) {
    seen.add(current)
    order.push(current)
    const from: string = current
    const $ = from === entry ? $entry : await parseFile(join(root, from))
    titles.set(from, pageTitle($, prettyName(basename(from))))
    if (from !== entry) graft(findToc($, generator, href => resolveLink(href, from, pages), false))
    const next = $(NEXT_LINK).first().attr('href')
    current = resolveLink(next, from, pages)?.path ?? null
  }
  return { order, titles }
}

/** Builds the manifest for a book made of a directory of pages. */
export async function buildWebBook(
  root: string,
  generator: WebGenerator,
  entry: string,
): Promise<WebBookManifest> {
  const pages = await collectPages(root)
  const $ = await parseFile(join(root, entry))

  let toc: TocNode[] = []
  if (generator === 'mdbook' && pages.has('toc.html')) {
    const $toc = await parseFile(join(root, 'toc.html'))
    toc = findToc($toc, generator, href => resolveLink(href, 'toc.html', pages))
  }
  if (countLinks(toc) < 2) toc = findToc($, generator, href => resolveLink(href, entry, pages))

  const spine: WebPage[] = []
  const seen = new Set<string>()
  const push = (path: string, title: string) => {
    if (seen.has(path) || !pages.has(path)) return
    seen.add(path)
    spine.push({ href: path, title, size: pages.get(path)! })
  }
  // mdBook ships its complete table of contents; other sites are walked.
  const walked =
    generator === 'mdbook' && countLinks(toc) >= 2
      ? null
      : await crawl(root, entry, $, pages, generator, toc)
  const flat = flattenToc(toc)
  const labels = new Map<string, string>()
  for (const node of flat) {
    const path = node.href?.replace(/#.*$/, '')
    if (path && !labels.has(path)) labels.set(path, node.label)
  }
  // mdBook's index.html is a copy of the first chapter; elsewhere the entry
  // page is the landing page and belongs at the front unless the TOC puts it
  // somewhere itself.
  const title = extractTitle($, generator, prettyName(basename(root)))
  if (!labels.has(entry) && generator !== 'mdbook') {
    push(entry, title)
    toc.unshift({ label: pageTitle($, title), href: entry, children: [] })
  }
  const tocPages = [...labels.keys()].filter(path => pages.has(path))
  if (walked && walked.order.length >= tocPages.length) {
    // The "next" chain is the reading order; it also reaches pages that no
    // table of contents mentions.
    for (const path of walked.order) push(path, labels.get(path) ?? walked.titles.get(path) ?? path)
  }
  for (const node of flat) if (node.href) push(node.href.replace(/#.*$/, ''), node.label)
  if (!spine.length) {
    // Nothing linked: fall back to every page in the directory, in name order.
    const names = [...pages.keys()].filter(path => !path.includes('/')).sort(naturalCompare)
    for (const name of names) push(name, prettyName(name))
    toc = spine.map(page => ({ label: page.title, href: page.href, children: [] }))
  }

  return {
    version: WEB_MANIFEST_VERSION,
    generator,
    title,
    author: clean($('meta[name="author"]').attr('content') ?? ''),
    language: clean($('html').attr('lang') ?? ''),
    description: clean(
      $('meta[name="description"]').attr('content') ??
        $('meta[property="og:description"]').attr('content') ??
        '',
    ),
    pages: spine,
    toc,
    cover: findCover($, entry),
  }
}

/** Builds the manifest for a single saved HTML file. */
export async function buildSinglePage(file: string): Promise<WebBookManifest> {
  const name = basename(file)
  const $ = await parseFile(file)
  const size = await stat(file).then(
    info => info.size,
    () => 0,
  )
  const title = extractTitle($, 'single', prettyName(name))
  // Headings become the table of contents.
  const toc: TocNode[] = []
  const stack: { level: number; node: TocNode }[] = []
  for (const el of $('h1, h2, h3').toArray()) {
    const $el = $(el)
    const label = clean($el.text())
    const id = $el.attr('id') ?? $el.find('[id]').first().attr('id') ?? $el.find('a[name]').attr('name')
    if (!label || !id) continue
    const level = Number(el.tagName[1])
    const node: TocNode = { label, href: `${name}#${id}`, children: [] }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else toc.push(node)
    stack.push({ level, node })
  }
  return {
    version: WEB_MANIFEST_VERSION,
    generator: 'single',
    title,
    author: clean($('meta[name="author"]').attr('content') ?? ''),
    language: clean($('html').attr('lang') ?? ''),
    description: clean($('meta[name="description"]').attr('content') ?? ''),
    pages: [{ href: name, title, size }],
    toc,
    cover: findCover($, name),
  }
}
