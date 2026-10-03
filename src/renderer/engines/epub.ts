/**
 * The engine for everything reflowable: EPUB, MOBI/KF8, FB2, CBZ and (through
 * the adapter in webbook.ts) HTML books. Books are foliate-js "book" objects;
 * this module is the glue between such a book, a renderer element and the
 * reader UI - the role foliate's own `view.js` plays, with two differences:
 * the renderer for scrolled flow is our continuous scroller, and locations
 * and annotation anchors go through a pluggable `Locator`.
 */
import { selectForContextMenu } from './context'
import type { Annotation, Selector, Settings } from '@shared/types'
import { Overlayer } from 'foliate-js/overlayer.js'
import { SectionProgress, TOCProgress, type SectionProgressInfo } from 'foliate-js/progress.js'
import { textWalker } from 'foliate-js/text-walker.js'
import type { Anchor, FoliateBook, FoliateTocItem, Resolved } from 'foliate-js/types'
import { anchorQuote, describeRange, rangeMatches } from '../annotations/anchor'
import { CFI, fromRange, toRange } from './cfi'
import { mathSettled, removeMath, typesetMath } from './math'
import { ipc } from '../lib/ipc'
import {
  INVERT_FILTER,
  PALETTES,
  applyFontSize,
  classifyImages,
  contentCSS,
  dropDarkSchemeRules,
  preInvert,
} from './appearance'
import './scroller'
import { speechSegments } from './speech'
import {
  HIGHLIGHT_HEX,
  type Appearance,
  type Engine,
  type EngineEvents,
  type Relocation,
  type SearchOptions,
  type SearchUpdate,
  type SpeechSegment,
  type TocItem,
  type ViewportRect,
} from './types'

/** The interface foliate's renderers (and our scroller) share. */
interface Renderer extends HTMLElement {
  open(book: FoliateBook): void
  goTo(target: { index: number; anchor?: Anchor | number; select?: boolean }): Promise<void>
  prev(distance?: number): Promise<void>
  next(distance?: number): Promise<void>
  getContents(): { doc: Document; index?: number; overlayer?: Overlayer }[]
  setStyles?(styles: string): void
  scrollToAnchor?(anchor: Range | Element, select?: boolean): Promise<void>
  flush?(): void
  destroy(): void
}

interface RelocateDetail {
  reason?: string
  range?: Range | null
  index: number
  fraction?: number
  size?: number
  /** The end of the book is in view (our scroller; foliate's renderers count the page instead). */
  atEnd?: boolean
}

type RangeAnchor = (doc: Document) => Range | null

/** Translates between live positions and what gets stored in the database. */
export interface Locator {
  toLocation(index: number, range: Range | null): string
  fromLocation(location: string): Resolved | null
  toSelector(index: number, range: Range): Selector | null
  fromSelector(selector: Selector): { index: number; anchor: RangeAnchor } | null
}

const quoteOf = (range: Range) => {
  const doc = range.startContainer.ownerDocument!
  return describeRange(doc.body ?? doc.documentElement, range)
}

/** The default: EPUB CFIs, as foliate-js produces them. */
export function cfiLocator(book: FoliateBook): Locator {
  const base = (index: number) => book.sections[index].cfi ?? CFI.fake.fromIndex(index)
  const full = (index: number, range: Range | null) =>
    range ? CFI.joinIndir(base(index), fromRange(range)) : base(index)
  const resolve = (cfi: string): { index: number; anchor: (doc: Document) => Range | null } | null => {
    try {
      const parts = CFI.parse(cfi)
      // The first step addresses the spine item; the rest is the path within it.
      const spine = ('parent' in parts ? parts.parent : parts).shift()
      const index = book.resolveCFI ? book.resolveCFI(cfi).index : CFI.fake.toIndex(spine)
      if (!(index >= 0)) return null
      return {
        index,
        anchor: doc => {
          try {
            return toRange(doc, parts)
          } catch {
            // the document no longer has what the CFI points at
            return null
          }
        },
      }
    } catch {
      return null
    }
  }
  return {
    toLocation: full,
    fromLocation(location) {
      const resolved = CFI.isCFI.test(location) ? resolve(location) : null
      // A place that cannot be found any more becomes the start of its section.
      return resolved && { index: resolved.index, anchor: doc => resolved.anchor(doc) ?? 0 }
    },
    toSelector(index, range) {
      const described = quoteOf(range)
      return described ? { type: 'cfi', cfi: full(index, range), quote: described.quote } : null
    },
    fromSelector(selector) {
      if (selector.type !== 'cfi') return null
      const resolved = resolve(selector.cfi)
      if (!resolved) return null
      return {
        index: resolved.index,
        anchor: doc => {
          const range = resolved.anchor(doc)
          if (range && (!selector.quote.exact || rangeMatches(range, selector.quote))) return range
          return anchorQuote(doc.body ?? doc.documentElement, selector.quote) ?? range
        },
      }
    },
  }
}

const DRAW = {
  highlight: Overlayer.highlight,
  underline: Overlayer.underline,
  squiggly: Overlayer.squiggly,
  strikethrough: Overlayer.strikethrough,
}

const annotationKey = (id: number) => `a:${id}`
const SEARCH_KEY = 's:'
/** The search result the reader is on: filled in, where the others are outlined. */
const drawCurrentHit: typeof Overlayer.outline = (rects, options = {}) => {
  const g = Overlayer.outline(rects, options)
  g.setAttribute('fill', String(options.color ?? 'orange'))
  g.setAttribute('fill-opacity', '0.35')
  return g
}
const SPEECH_KEY = 'tts'

function toViewport(doc: Document, rect: DOMRect): ViewportRect {
  const frame = doc.defaultView?.frameElement as HTMLElement | null
  if (!frame) return rect
  const box = frame.getBoundingClientRect()
  // Fixed-layout pages are scaled with a CSS transform.
  const scale = frame.offsetWidth ? box.width / frame.offsetWidth : 1
  return {
    left: box.left + rect.left * scale,
    top: box.top + rect.top * scale,
    right: box.left + rect.right * scale,
    bottom: box.top + rect.bottom * scale,
  }
}

/**
 * Some books list every chapter and section at one level, although their
 * numbering ("3.", "3.1.", "3.2.") says how they nest. Rebuilds the nesting
 * of a list that has none of its own; any other list is returned as it is.
 */
export function nestNumbered(toc: FoliateTocItem[]): FoliateTocItem[] {
  if (toc.some(item => item.subitems?.length)) return toc
  const numberOf = (label: string): number[] | null => {
    const match = /^\s*(\d+(?:\.\d+)*)\.?(?=\s|$)/.exec(label)
    return match ? match[1].split('.').map(Number) : null
  }
  const nested: FoliateTocItem[] = []
  // the numbered entries that later ones can still go under, outermost first
  let open: { number: number[]; item: FoliateTocItem }[] = []
  let moved = false
  for (const original of toc) {
    const item = { ...original }
    const number = numberOf(item.label ?? '')
    if (!number) {
      // "Foreword", "Appendix": ends whatever chapter was open
      open = []
      nested.push(item)
      continue
    }
    const contains = (parent: number[]) =>
      parent.length < number.length && parent.every((part, i) => part === number[i])
    while (open.length && !contains(open[open.length - 1].number)) open.pop()
    const parent = open[open.length - 1]?.item
    if (parent) {
      parent.subitems = [...(parent.subitems ?? []), item]
      moved = true
    } else nested.push(item)
    open.push({ number, item })
  }
  return moved ? nested : toc
}

/** A contents entry with the place it points to: a section, and maybe an element in it. */
export interface TocPlace {
  item: FoliateTocItem
  section: number
  fragment: unknown
}

/**
 * The contents entries that lead somewhere, in reading order, with the
 * section each starts in. (foliate's TOCProgress works the same out, but
 * keeps it to itself.)
 */
export async function tocPlaces(
  toc: FoliateTocItem[],
  ids: unknown[],
  splitHref: (href: string) => unknown[] | Promise<unknown[]>,
): Promise<TocPlace[]> {
  const sectionOf = new Map(ids.map((id, index) => [id, index]))
  const places: TocPlace[] = []
  const walk = async (items: FoliateTocItem[]): Promise<void> => {
    for (const item of items) {
      if (item.href) {
        const [id, fragment] = (await splitHref(item.href)) ?? []
        const section = sectionOf.get(id)
        if (section != null) places.push({ item, section, fragment })
      }
      if (item.subitems) await walk(item.subitems)
    }
  }
  await walk(toc)
  return places
}

/**
 * The contents entry a section belongs to, going by the section alone: the
 * first entry that starts in it (its own title, usually), or else the last
 * one before it. Which of several entries inside one section a position
 * falls under takes the section's text to tell.
 */
export function tocEntryOf(places: TocPlace[], section: number): FoliateTocItem | null {
  const own = places.find(place => place.section === section)
  return (own ?? places.findLast(place => place.section < section))?.item ?? null
}

const HEADINGS = 'h1, h2, h3, h4, h5, h6'
const HEADING_LINKS = `:is(${HEADINGS}) a[href], a[href]:has(> :is(${HEADINGS}))`
const SELF_LINK = 'data-bv-self-link'

/**
 * Whether a link only points at the heading it belongs to. mdBook wraps the
 * text of every heading in such a link (older versions wrap the link around
 * the heading), and so do the EPUBs made from its books.
 */
export function isSelfLink(link: Element): boolean {
  const inside = link.firstElementChild
  const heading = link.closest(HEADINGS) ?? (inside?.matches(HEADINGS) && link.children.length === 1 ? inside : null)
  const href = link.getAttribute('href') ?? ''
  const hash = href.indexOf('#')
  if (!heading || hash < 0) return false
  let id = href.slice(hash + 1)
  try {
    id = decodeURIComponent(id)
  } catch {
    // keep as written
  }
  if (!id) return false
  const doc = link.ownerDocument
  const target = doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`)
  if (!target) return false
  // the link or heading itself, something in the heading, or the section the
  // heading is the title of
  return (
    target === link || target === heading || heading.contains(target) || target.querySelector(HEADINGS) === heading
  )
}

/**
 * Repairs that go on top of the typography in every book. A heading that
 * links to itself should look like a heading, not a link; and code is never
 * centred or justified, whatever the figure or list around it says.
 */
const REPAIRS_CSS = `
  a[${SELF_LINK}] {
    color: inherit !important;
    text-decoration: none !important;
    cursor: inherit !important;
  }
  pre { text-align: start; }
`

export interface ReflowOptions {
  locator?: Locator
  /** A comic: pages are images, which the scroller can stack like a webtoon. */
  comic?: boolean
  /** Called for every section document as it loads, before it is shown. */
  prepare?(doc: Document, index: number): void
}

export class ReflowEngine implements Engine {
  toc: TocItem[] = []
  chapterStarts: number[] = []
  readonly reflowable: boolean
  readonly language: string

  private locator: Locator
  private renderer: Renderer | null = null
  private container: HTMLElement | null = null
  private appearance!: Appearance
  private sectionProgress: SectionProgress
  private tocProgress: TOCProgress | null = null
  private tocPlaces: TocPlace[] = []
  private tocTargets = new Map<number, string>()
  private annotations = new Map<number, Annotation>()
  private resolved = new Map<number, { index: number; anchor: RangeAnchor } | null>()
  private searchHits = new Map<number, string[]>()
  private searchRun = 0
  private currentHit: string | null = null
  private speechRange: { index: number; range: Range } | null = null
  private last: { index: number; range: Range | null; location: string; fraction: number } | null =
    null
  private wheelLock = 0
  /** The section documents that have loaded (see `onRelocate`). */
  private loaded = new WeakSet<Document>()
  /** The moves asked of the renderer that are not over yet (see `settled`). */
  private moving: Promise<unknown> = Promise.resolve()
  private destroyed = false

  constructor(
    private book: FoliateBook,
    private events: EngineEvents,
    private options: ReflowOptions = {},
  ) {
    this.locator = options.locator ?? cfiLocator(book)
    this.reflowable = book.rendition?.layout !== 'pre-paginated'
    const language = book.metadata?.language
    this.language = (Array.isArray(language) ? language[0] : language) ?? ''
    this.sectionProgress = new SectionProgress(book.sections, 1500, 1600)
  }

  async open(
    container: HTMLElement,
    init: { location: string | null; appearance: Appearance; annotations: Annotation[] },
  ): Promise<void> {
    this.container = container
    this.appearance = init.appearance
    for (const annotation of init.annotations) this.annotations.set(annotation.id, annotation)

    const { book } = this
    const toc = nestNumbered(book.toc ?? [])
    if (book.splitTOCHref && book.getTOCFragment) {
      const ids = book.sections.map(section => section.id)
      const splitHref = book.splitTOCHref.bind(book)
      this.tocProgress = new TOCProgress()
      await this.tocProgress.init({ toc, ids, splitHref, getFragment: book.getTOCFragment.bind(book) })
      this.tocPlaces = await tocPlaces(toc, ids, splitHref)
    }
    let nextId = 0
    const convert = (items: FoliateTocItem[] | null | undefined): TocItem[] =>
      (items ?? []).map(item => {
        const id = item.id ?? nextId++
        if (item.href) this.tocTargets.set(id, item.href)
        return {
          id: String(id),
          label: item.label?.trim() || 'Untitled',
          target: item.href ?? null,
          children: convert(item.subitems),
        }
      })
    this.toc = convert(toc)
    const starts = new Set<number>()
    for (const item of toc) {
      const index = item.href ? this.resolve(item.href)?.index : undefined
      const at = index != null ? this.sectionProgress.sectionFractions[index] : undefined
      if (at != null && at > 0 && at < 1) starts.add(at)
    }
    this.chapterStarts = [...starts].sort((a, b) => a - b)

    await this.createRenderer()
    const start = init.location ? this.resolve(init.location) : null
    if (start) await this.renderer!.goTo(start)
    else await this.goToTextStart()
  }

  private async goToTextStart(): Promise<void> {
    const { book } = this
    const index = Math.max(
      0,
      book.sections.findIndex(section => section.linear !== 'no'),
    )
    // Start where the text starts if the book says where that is; books are
    // sloppy about landmarks, so anything odd falls back to the first section.
    let target: Resolved | null = null
    try {
      const landmark = book.landmarks?.find(
        mark => mark.type?.includes('bodymatter') || mark.type?.includes('text'),
      )
      const resolved = landmark ? await book.resolveHref(landmark.href) : null
      if (resolved && resolved.index >= 0 && resolved.index < book.sections.length) target = resolved
    } catch {
      target = null
    }
    await this.renderer!.goTo(target ?? { index })
  }

  private get flow(): Settings['flow'] {
    return this.appearance.settings.flow
  }

  private async createRenderer(): Promise<void> {
    const { book, container } = this
    if (!container) return
    this.dropRenderer()

    let tag: string
    // Fixed-layout EPUB pages have a designed size and cannot be stacked
    // in a column; comics can.
    if (this.flow === 'scrolled' && (this.reflowable || this.options.comic)) tag = 'bv-scroller'
    else if (!this.reflowable) {
      await import('foliate-js/fixed-layout.js')
      tag = 'foliate-fxl'
    } else {
      await import('foliate-js/paginator.js')
      tag = 'foliate-paginator'
    }
    // closed, or switched again, while the renderer's code was loading
    if (this.destroyed || this.renderer) return
    const renderer = document.createElement(tag) as Renderer
    this.renderer = renderer
    renderer.dataset.kind = tag
    renderer.addEventListener('load', event =>
      this.onLoad((event as CustomEvent<{ doc: Document; index: number }>).detail),
    )
    renderer.addEventListener('relocate', event =>
      this.onRelocate((event as CustomEvent<RelocateDetail>).detail),
    )
    renderer.addEventListener('create-overlayer', event => {
      const detail = (
        event as CustomEvent<{
          doc: Document
          index: number
          attach(overlayer: Overlayer): void
        }>
      ).detail
      const overlayer = new Overlayer()
      detail.attach(overlayer)
      this.drawSection(detail.index, detail.doc, overlayer)
    })
    // the page margins around the text, which belong to the renderer itself
    renderer.addEventListener('wheel', this.onWheel, { passive: false })
    this.applyLayout()
    renderer.open(book)
    container.replaceChildren(renderer)
    this.applyStyles()
  }

  /* ---------- appearance ---------- */

  private applyLayout(): void {
    const { renderer } = this
    if (!renderer) return
    const { settings, theme } = this.appearance
    const palette = PALETTES[theme]
    renderer.setAttribute('flow', this.flow)
    renderer.setAttribute('animated', '')
    renderer.setAttribute('gap', '6%')
    renderer.setAttribute('margin', '40px')
    renderer.setAttribute(
      'max-inline-size',
      `${this.options.comic ? Math.max(900, settings.maxWidth) : settings.maxWidth}px`,
    )
    renderer.setAttribute('max-column-count', String(settings.maxColumns))
    renderer.style.setProperty('--bv-filter', palette.invert ? INVERT_FILTER : 'none')
    renderer.style.setProperty('--bv-page-bg', palette.invert ? preInvert(palette.bg) : palette.bg)
    renderer.style.setProperty('--overlayer-highlight-opacity', palette.invert ? '0.4' : '0.35')
    renderer.style.setProperty(
      '--overlayer-highlight-blend-mode',
      palette.invert ? 'screen' : 'multiply',
    )
    renderer.classList.toggle('inverted', palette.invert)
  }

  private applyStyles(): void {
    const { renderer } = this
    if (!renderer) return
    // Per-document sizing first: the renderer measures and re-fits each
    // section (keeping the reading position) as it takes the stylesheet.
    for (const { doc } of renderer.getContents()) this.styleDocument(doc)
    renderer.setStyles?.(contentCSS(this.appearance) + REPAIRS_CSS)
  }

  private styleDocument(doc: Document): void {
    if (!doc?.body) return
    dropDarkSchemeRules(doc)
    const inverted = PALETTES[this.appearance.theme].invert
    if (this.reflowable) applyFontSize(doc, this.appearance.settings.fontSize)
    if (inverted) classifyImages(doc)
    if (!this.renderer?.setStyles && doc.head) {
      // The fixed-layout renderer takes no stylesheet: pages keep their own
      // design, but pictures still must not come out as negatives.
      let style = doc.head.querySelector<HTMLStyleElement>('style[data-bv-theme]')
      if (!style) {
        style = doc.createElement('style')
        style.setAttribute('data-bv-theme', '')
        doc.head.append(style)
      }
      style.textContent = inverted
        ? `img:not([data-bv-inverted]), video, svg image:not([data-bv-inverted]) { filter: ${INVERT_FILTER}; }`
        : ''
    }
  }

  private renderMath(doc: Document, index?: number): void {
    if (!this.appearance.settings.renderMath) return
    void typesetMath(doc).then(changed => {
      if (!changed || index == null || this.destroyed) return
      // Rendering replaced the text nodes that the marks' ranges pointed
      // into: anchor everything on this section afresh.
      if (this.speechRange?.index === index) this.clearSpeechMark()
      const overlayer = this.overlayerOf(index)
      if (overlayer) this.drawSection(index, doc, overlayer)
    })
  }

  /** Lets go of the current renderer. (foliate's can throw if it never showed anything.) */
  private dropRenderer(): void {
    const { renderer } = this
    this.renderer = null
    if (!renderer) return
    try {
      renderer.destroy()
    } catch {
      // nothing was displayed yet
    }
    renderer.remove()
  }

  setAppearance(appearance: Appearance): void {
    const flowChanged = appearance.settings.flow !== this.appearance.settings.flow
    const mathChanged = appearance.settings.renderMath !== this.appearance.settings.renderMath
    this.appearance = appearance
    if (mathChanged)
      for (const { doc, index } of this.renderer?.getContents() ?? []) {
        if (appearance.settings.renderMath) this.renderMath(doc, index)
        else removeMath(doc)
      }
    if (flowChanged) {
      const location = this.last?.location
      void this.createRenderer().then(() => {
        const target = location ? this.resolve(location) : null
        return this.renderer?.goTo(target ?? { index: 0 })
      })
      return
    }
    this.applyLayout()
    this.applyStyles()
  }

  /* ---------- section lifecycle ---------- */

  private onLoad({ doc, index }: { doc: Document; index: number }): void {
    const { book } = this
    const section = book.sections[index]
    this.loaded.add(doc)
    doc.documentElement.lang ||= this.language
    if (book.dir === 'rtl') doc.documentElement.dir ||= 'rtl'
    this.options.prepare?.(doc, index)
    this.markSelfLinks(doc, index)
    this.styleDocument(doc)
    this.renderMath(doc, index)

    doc.addEventListener('click', event => {
      const target = event.target as Element | null
      const link = target?.closest?.('a[href]')
      // (the frame must not follow a heading's link to itself either)
      if (link?.hasAttribute(SELF_LINK)) event.preventDefault()
      else if (link) {
        event.preventDefault()
        const raw = link.getAttribute('href') ?? ''
        const href = section?.resolveHref?.(raw) ?? raw
        if (book.isExternal?.(href) ?? /^[a-z][a-z0-9+.-]*:/i.test(href)) {
          const url = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : raw
          void ipc.invoke('shell:openExternal', url.startsWith('//') ? 'https:' + url : url)
        }
        else if (this.resolve(href)) {
          this.events.jump()
          void this.goTo(href)
        }
        return
      }
      const selection = doc.getSelection()
      if (selection && !selection.isCollapsed) return
      const overlayer = this.overlayerOf(index)
      const [key, range] = overlayer?.hitTest({ x: event.clientX, y: event.clientY }) ?? []
      if (key?.startsWith('a:') && range) {
        this.events.annotationClick(
          Number(key.slice(2)),
          toViewport(doc, range.getBoundingClientRect()),
        )
        return
      }
      this.events.click()
    })

    const reportSelection = () => {
      const selection = doc.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) return
      const range = selection.getRangeAt(0)
      const text = selection.toString().trim()
      if (!text) return
      const selector = this.locator.toSelector(index, range)
      if (!selector) return
      this.events.selection({
        text,
        selector,
        label: this.tocProgress?.getProgress(index, range)?.label?.trim() ?? '',
        position: this.fractionOf(index, range, doc),
        rect: toViewport(doc, range.getBoundingClientRect()),
        language: doc.documentElement.lang || this.language,
      })
    }
    doc.addEventListener('pointerup', () => setTimeout(reportSelection))
    doc.addEventListener('keyup', event => {
      if (event.shiftKey || event.key === 'Shift') reportSelection()
    })
    doc.addEventListener('selectionchange', () => {
      if (doc.getSelection()?.isCollapsed) this.events.selection(null)
    })
    // Right-click acts on the word under the pointer (or the selection clicked on).
    doc.addEventListener('contextmenu', event => {
      event.preventDefault()
      if (selectForContextMenu(doc, event)) reportSelection()
    })
    doc.addEventListener('keydown', event => this.events.keydown(event))
    // Dragging links and pictures out of the page only gets in the way of selecting.
    doc.addEventListener('dragstart', event => event.preventDefault())
    doc.addEventListener('wheel', this.onWheel, { passive: false })
  }

  /** Marks the links that only lead to the heading they sit in (REPAIRS_CSS restyles them). */
  private markSelfLinks(doc: Document, index: number): void {
    const section = this.book.sections[index]
    for (const link of doc.querySelectorAll(HEADING_LINKS)) {
      const href = link.getAttribute('href') ?? ''
      // (the same fragment in another file is a real link)
      const here = href.startsWith('#') || this.resolve(section?.resolveHref?.(href) ?? href)?.index === index
      if (here && isSelfLink(link)) link.setAttribute(SELF_LINK, '')
    }
  }

  /** Scrolled flow scrolls natively; in paginated flow a wheel gesture turns the page. */
  private onWheel = (event: WheelEvent): void => {
    if (this.renderer?.dataset.kind === 'bv-scroller' || event.ctrlKey) return
    event.preventDefault()
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    const now = Date.now()
    if (Math.abs(delta) < 8 || now < this.wheelLock) return
    this.wheelLock = now + 280
    if (delta > 0) this.next()
    else this.prev()
  }

  private onRelocate({ range, index, fraction = 0, size, atEnd }: RelocateDetail): void {
    // foliate's paginator, laid out again while a section is still loading,
    // reports a place in the empty document its frame has until then. That
    // is nowhere in the book, and must not be taken (and saved) for where
    // the reader is.
    if (range && !this.loaded.has(range.startContainer.ownerDocument!)) return
    const progress = this.sectionProgress.getProgress(index, fraction, size)
    const tocItem = this.tocProgress?.getProgress(index, range ?? undefined)
    const location = this.locator.toLocation(index, range ?? null)
    // The position is that of the top of the view, which stops short of the
    // end by a screenful: a book read to its end is nevertheless finished.
    const bookFraction = atEnd ? 1 : Number.isFinite(progress.fraction) ? progress.fraction : 0
    this.last = { index, range: range ?? null, location, fraction: bookFraction }
    let excerpt = ''
    try {
      excerpt = (range?.toString() ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
    } catch {
      // a detached range
    }
    this.events.relocate({
      fraction: bookFraction,
      location,
      tocId: tocItem?.id != null ? String(tocItem.id) : null,
      label: tocItem?.label?.trim() ?? '',
      page: this.pageOf(index, progress),
      excerpt,
      minutesLeft: this.reflowable
        ? { chapter: progress.time.section, book: progress.time.total }
        : undefined,
    })
  }

  /** The readout for a place: locations in a book that reflows, pages in one that does not. */
  private pageOf(index: number, progress: SectionProgressInfo): Relocation['page'] {
    return this.reflowable
      ? { current: progress.location.current + 1, total: progress.location.total, unit: 'loc' }
      : { current: index + 1, total: this.book.sections.length, unit: 'page' }
  }

  /** Approximate position of a range in the whole book, 0..1. */
  private fractionOf(index: number, range: Range, doc: Document): number {
    let inSection = 0
    try {
      const before = doc.createRange()
      before.selectNodeContents(doc.body)
      before.setEnd(range.startContainer, range.startOffset)
      const total = doc.body.textContent?.length || 1
      inSection = Math.min(1, before.toString().length / total)
    } catch {
      // keep the section start
    }
    const fraction = this.sectionProgress.getProgress(index, inSection).fraction
    return Number.isFinite(fraction) ? fraction : 0
  }

  /* ---------- navigation ---------- */

  /** Resolves a stored location, CFI, or href to a section and anchor. */
  private resolve(target: string): Resolved | null {
    try {
      return this.locator.fromLocation(target) ?? this.book.resolveHref(target) ?? null
    } catch {
      return null
    }
  }

  async goTo(target: string): Promise<void> {
    const resolved = this.resolve(target)
    if (!resolved || !this.renderer) return
    try {
      await this.move(this.renderer.goTo(resolved))
    } catch (error) {
      console.warn(`Could not go to ${target}:`, error)
    }
  }

  async goToFraction(fraction: number): Promise<void> {
    const [index, inSection] = this.sectionProgress.getSection(fraction)
    await this.move(this.renderer?.goTo({ index, anchor: inSection }))
  }

  describe(fraction: number): { label: string; page: Relocation['page'] } {
    const [index, inSection] = this.sectionProgress.getSection(fraction)
    const item = this.entryInView(index, inSection) ?? tocEntryOf(this.tocPlaces, index)
    return {
      label: item?.label?.trim() ?? '',
      page: this.pageOf(index, this.sectionProgress.getProgress(index, inSection)),
    }
  }

  /**
   * The contents entry at a position in a section that the scroller has laid
   * out right now, found the way arriving there finds it: from the text that
   * would be on screen. Undefined when the section is not at hand (telling
   * would take loading it).
   */
  private entryInView(index: number, inSection: number): FoliateTocItem | null | undefined {
    const { renderer, tocProgress } = this
    if (renderer?.dataset.kind !== 'bv-scroller' || !tocProgress) return undefined
    // (a section that is one entry from top to bottom needs no looking at)
    const own = this.tocPlaces.filter(place => place.section === index)
    if (own.length < 2 && !own[0]?.fragment) return undefined
    const doc = renderer.getContents().find(content => content.index === index)?.doc
    const view = doc?.defaultView
    const frame = view?.frameElement as HTMLElement | null | undefined
    if (!doc?.body || !view || !frame) return undefined
    // The same reading the scroller takes when it reports a place: from just
    // inside the text column at the top edge to the far corner of the screen.
    const pad = parseFloat(view.getComputedStyle(doc.documentElement).paddingLeft) || 0
    const width = doc.documentElement.clientWidth
    const top = inSection * frame.offsetHeight
    const bottom = Math.min(frame.offsetHeight - 1, top + renderer.clientHeight)
    const caret = (x: number, y: number): Range | null => {
      try {
        return doc.caretRangeFromPoint(x, y)
      } catch {
        return null
      }
    }
    const start = caret(pad + 2, top + 4) ?? caret(width / 2, top + 4)
    const end = caret(width - pad - 2, bottom - 4) ?? caret(width / 2, bottom - 4)
    if (!start) return undefined
    const range = doc.createRange()
    try {
      range.setStart(start.startContainer, start.startOffset)
      if (end && range.comparePoint(end.startContainer, end.startOffset) >= 0)
        range.setEnd(end.startContainer, end.startOffset)
    } catch {
      return undefined
    }
    return tocProgress.getProgress(index, range)
  }

  isInView(location: string): boolean {
    const { last, renderer, container } = this
    if (!last || !renderer || !container) return false
    if (location === last.location) return true
    let resolved: Resolved | null
    try {
      resolved = this.locator.fromLocation(location)
    } catch {
      resolved = null
    }
    if (!resolved) return false
    const { index, anchor } = resolved
    const doc = renderer.getContents().find(content => (content.index ?? last.index) === index)?.doc
    if (!doc?.body) return false
    let rect: DOMRect | undefined
    try {
      const target = typeof anchor === 'function' ? anchor(doc) : (anchor ?? 0)
      if (typeof target === 'number') {
        // only the start of a section can be placed without laying it out again
        if (target > 0) return false
        rect = doc.body.getClientRects()[0]
      } else if (target) {
        const rects = Array.from(target.getClientRects())
        rect = rects.find(r => r.width > 0 || r.height > 0) ?? rects[0]
      }
    } catch {
      return false
    }
    if (!rect) return false
    const at = toViewport(doc, rect)
    const box = container.getBoundingClientRect()
    if (renderer.dataset.kind === 'bv-scroller') {
      // Nothing snaps to a page here: the place stays "this screen" until
      // it is a good way above the top.
      return at.top >= box.top - box.height * 0.4 && at.top < box.bottom
    }
    return at.left >= box.left - 1 && at.left < box.right - 1 && at.top < box.bottom
  }

  next(): void {
    void this.move(this.renderer?.next())
  }

  prev(): void {
    void this.move(this.renderer?.prev())
  }

  step(direction: 1 | -1): void {
    const distance = this.flow === 'scrolled' ? 72 : undefined
    void this.move(direction > 0 ? this.renderer?.next(distance) : this.renderer?.prev(distance))
  }

  goToEdge(edge: 'start' | 'end'): void {
    const { sections } = this.book
    const linear = (section: { linear?: string }) => section.linear !== 'no'
    if (edge === 'start')
      void this.move(this.renderer?.goTo({ index: Math.max(0, sections.findIndex(linear)) }))
    else void this.move(this.renderer?.goTo({ index: sections.findLastIndex(linear), anchor: 1 }))
  }

  /** Keeps track of a move of the renderer until it is over. */
  private move(done: Promise<void> | undefined): Promise<void> {
    const over = Promise.resolve(done)
    this.moving = Promise.allSettled([this.moving, over])
    return over
  }

  flush(): void {
    this.renderer?.flush?.()
  }

  settled(): Promise<void> {
    // (not for ever: a section that will not load must not keep the reader waiting)
    const patience = new Promise(resolve => setTimeout(resolve, 1000))
    return Promise.race([this.moving, patience]).then(() => {})
  }

  focus(): void {
    this.renderer?.getContents()[0]?.doc?.defaultView?.focus()
  }

  /* ---------- annotations, search and speech marks ---------- */

  private overlayerOf(index: number): Overlayer | undefined {
    return this.renderer?.getContents().find(content => content.index === index)?.overlayer
  }

  private resolveAnnotation(annotation: Annotation) {
    let resolved = this.resolved.get(annotation.id)
    if (resolved === undefined) {
      resolved = this.locator.fromSelector(annotation.selector)
      this.resolved.set(annotation.id, resolved)
    }
    return resolved
  }

  private drawAnnotation(annotation: Annotation, doc: Document, overlayer: Overlayer): void {
    const key = annotationKey(annotation.id)
    overlayer.remove(key)
    const resolved = this.resolveAnnotation(annotation)
    if (!resolved) return
    let range: Range | null = null
    try {
      range = resolved.anchor(doc)
    } catch {
      range = null
    }
    if (!range) return
    const color = HIGHLIGHT_HEX[annotation.color] ?? HIGHLIGHT_HEX.yellow
    overlayer.add(key, range, DRAW[annotation.style] ?? DRAW.highlight, {
      color,
      width: 2,
      writingMode: doc.defaultView?.getComputedStyle(doc.body).writingMode,
    })
  }

  /** Draws everything that belongs on a freshly loaded section. */
  private drawSection(index: number, doc: Document, overlayer: Overlayer): void {
    for (const annotation of this.annotations.values())
      if (this.resolveAnnotation(annotation)?.index === index)
        this.drawAnnotation(annotation, doc, overlayer)
    for (const target of this.searchHits.get(index) ?? []) this.drawSearchHit(target, doc, overlayer)
    if (this.speechRange?.index === index) this.drawSpeechMark()
  }

  setAnnotations(annotations: Annotation[]): void {
    const next = new Map(annotations.map(annotation => [annotation.id, annotation]))
    const contents = this.renderer?.getContents() ?? []
    for (const [id, old] of this.annotations) {
      const current = next.get(id)
      if (current && JSON.stringify(current.selector) === JSON.stringify(old.selector)) continue
      this.resolved.delete(id)
      for (const { overlayer } of contents) overlayer?.remove(annotationKey(id))
    }
    this.annotations = next
    for (const annotation of next.values()) {
      const resolved = this.resolveAnnotation(annotation)
      if (!resolved) continue
      for (const { index, doc, overlayer } of contents)
        if (index === resolved.index && overlayer) this.drawAnnotation(annotation, doc, overlayer)
    }
  }

  async showAnnotation(annotation: Annotation): Promise<void> {
    const resolved = this.resolveAnnotation(annotation)
    if (!resolved || !this.renderer) return
    await this.move(this.renderer.goTo(resolved))
    const content = this.renderer.getContents().find(c => c.index === resolved.index)
    const range = content ? resolved.anchor(content.doc) : null
    if (content && range)
      this.events.annotationClick(annotation.id, toViewport(content.doc, range.getBoundingClientRect()))
  }

  clearSelection(): void {
    for (const { doc } of this.renderer?.getContents() ?? []) doc?.getSelection()?.removeAllRanges()
  }

  private drawSearchHit(target: string, doc: Document, overlayer: Overlayer): void {
    const resolved = this.resolve(target)
    if (!resolved || typeof resolved.anchor !== 'function') return
    try {
      const range = resolved.anchor(doc)
      if (range instanceof (doc.defaultView as typeof globalThis).Range)
        overlayer.add(SEARCH_KEY + target, range, target === this.currentHit ? drawCurrentHit : Overlayer.outline, {
          color: PALETTES[this.appearance.theme].invert ? '#ffb347' : '#e8590c',
          width: 2,
          radius: 2,
        })
    } catch {
      // the hit no longer resolves; nothing to draw
    }
  }

  async *search(query: string, options: SearchOptions): AsyncGenerator<SearchUpdate> {
    this.clearSearch()
    const run = this.searchRun
    const { searchMatcher } = await import('foliate-js/search.js')
    const matcher = searchMatcher(textWalker, {
      defaultLocale: this.language || 'en',
      matchCase: options.matchCase,
      matchWholeWords: options.wholeWords,
      matchDiacritics: false,
    })
    const { sections } = this.book
    for (const [index, section] of sections.entries()) {
      if (run !== this.searchRun || this.destroyed) return
      if (section.createDocument) {
        let doc: Document | null = null
        try {
          doc = await section.createDocument()
        } catch {
          doc = null
        }
        if (run !== this.searchRun) return
        if (doc?.body) {
          const hits = []
          for (const { range, excerpt } of matcher(doc, query)) {
            hits.push({ target: this.locator.toLocation(index, range), ...excerpt })
            if (hits.length >= 500) break
          }
          if (hits.length) {
            const targets = hits.map(hit => hit.target)
            this.searchHits.set(index, targets)
            const content = this.renderer?.getContents().find(c => c.index === index)
            if (content?.overlayer)
              for (const target of targets) this.drawSearchHit(target, content.doc, content.overlayer)
            yield {
              group: {
                label: this.tocProgress?.getProgress(index)?.label?.trim() ?? `Section ${index + 1}`,
                hits,
              },
            }
          }
        }
      }
      yield { progress: (index + 1) / sections.length }
    }
  }

  markSearchHit(target: string | null): void {
    const changed = [this.currentHit, target]
    this.currentHit = target
    for (const hit of changed) {
      const index = hit ? this.resolve(hit)?.index : undefined
      const content = this.renderer?.getContents().find(c => c.index === index)
      if (!hit || !content?.overlayer) continue
      content.overlayer.remove(SEARCH_KEY + hit)
      this.drawSearchHit(hit, content.doc, content.overlayer)
    }
  }

  clearSearch(): void {
    this.searchRun++
    this.currentHit = null
    for (const { index, overlayer } of this.renderer?.getContents() ?? []) {
      if (index == null || !overlayer) continue
      for (const target of this.searchHits.get(index) ?? []) overlayer.remove(SEARCH_KEY + target)
    }
    this.searchHits.clear()
  }

  private drawSpeechMark(): void {
    const mark = this.speechRange
    if (!mark) return
    this.overlayerOf(mark.index)?.add(SPEECH_KEY, mark.range, Overlayer.highlight, {
      color: PALETTES[this.appearance.theme].invert ? '#7fb2ff' : '#3b82f6',
    })
  }

  clearSpeechMark(): void {
    for (const { overlayer } of this.renderer?.getContents() ?? []) overlayer?.remove(SPEECH_KEY)
    this.speechRange = null
  }

  async *speech(): AsyncGenerator<SpeechSegment[]> {
    const { sections } = this.book
    let index = this.last?.index ?? 0
    // Start from a selection if there is one, else from the top of the view.
    let from: Range | null = null
    for (const content of this.renderer?.getContents() ?? []) {
      const selection = content.doc?.getSelection()
      if (selection && !selection.isCollapsed && selection.rangeCount && content.index != null) {
        from = selection.getRangeAt(0).cloneRange()
        index = content.index
        selection.removeAllRanges()
      }
    }
    from ??= this.last?.range ?? null

    // Picture-only sections are skipped, but a book that turns out to have
    // no text at all (a comic) should not be flipped through to its end.
    let silent = 0
    while (index < sections.length && !this.destroyed && silent < 4) {
      const renderer = this.renderer
      if (!renderer) return
      const find = () => {
        const contents = renderer.getContents()
        // the fixed-layout renderer does not say which section a page is
        return contents.find(c => c.index === index) ?? contents.find(c => c.index == null)
      }
      let content = renderer.getContents().find(c => c.index === index)
      if (!content) {
        await renderer.goTo({ index })
        content = find()
      }
      if (!content?.doc?.body) return
      const { doc } = content
      // Formulas are rendered in place; wait, or we would read (and later
      // lose track of) their TeX source.
      await mathSettled(doc)
      const language = doc.documentElement.lang || this.language || 'en'
      const section = index
      const batch = Array.from(speechSegments(doc, language, from), ({ text, range }) => ({
        text,
        language,
        show: () => {
          this.clearSpeechMark()
          this.speechRange = { index: section, range }
          this.drawSpeechMark()
          void this.renderer?.scrollToAnchor?.(range)
        },
      }))
      if (batch.length) {
        silent = 0
        yield batch
      } else silent++
      from = null
      do index++
      while (index < sections.length && sections[index].linear === 'no')
    }
  }

  destroy(): void {
    this.destroyed = true
    this.searchRun++
    this.dropRenderer()
    this.book.destroy?.()
  }
}
