/**
 * The engine for everything reflowable: EPUB, MOBI/KF8, FB2, CBZ and (through
 * the adapter in webbook.ts) HTML books. Books are foliate-js "book" objects;
 * this module is the glue between such a book, a renderer element and the
 * reader UI - the role foliate's own `view.js` plays, with two differences:
 * the renderer for scrolled flow is our continuous scroller, and locations
 * and annotation anchors go through a pluggable `Locator`.
 */
import type { Annotation, Selector, Settings } from '@shared/types'
import { Overlayer } from 'foliate-js/overlayer.js'
import { SectionProgress, TOCProgress } from 'foliate-js/progress.js'
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
  preInvert,
} from './appearance'
import './scroller'
import { speechSegments } from './speech'
import {
  HIGHLIGHT_HEX,
  type Appearance,
  type Engine,
  type EngineEvents,
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
  destroy(): void
}

interface RelocateDetail {
  reason?: string
  range?: Range | null
  index: number
  fraction?: number
  size?: number
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
  const resolve = (cfi: string): { index: number; anchor: (doc: Document) => Range } | null => {
    try {
      const parts = CFI.parse(cfi)
      // The first step addresses the spine item; the rest is the path within it.
      const spine = ('parent' in parts ? parts.parent : parts).shift()
      const index = book.resolveCFI ? book.resolveCFI(cfi).index : CFI.fake.toIndex(spine)
      if (!(index >= 0)) return null
      return { index, anchor: doc => toRange(doc, parts) }
    } catch {
      return null
    }
  }
  return {
    toLocation: full,
    fromLocation: location => (CFI.isCFI.test(location) ? resolve(location) : null),
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
          let range: Range | null = null
          try {
            range = resolved.anchor(doc)
          } catch {
            range = null
          }
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

export interface ReflowOptions {
  locator?: Locator
  /** A comic: pages are images, which the scroller can stack like a webtoon. */
  comic?: boolean
  /** Called for every section document as it loads, before it is shown. */
  prepare?(doc: Document, index: number): void
}

export class ReflowEngine implements Engine {
  toc: TocItem[] = []
  readonly reflowable: boolean
  readonly language: string

  private locator: Locator
  private renderer: Renderer | null = null
  private container: HTMLElement | null = null
  private appearance!: Appearance
  private sectionProgress: SectionProgress
  private tocProgress: TOCProgress | null = null
  private tocTargets = new Map<number, string>()
  private annotations = new Map<number, Annotation>()
  private resolved = new Map<number, { index: number; anchor: RangeAnchor } | null>()
  private searchHits = new Map<number, string[]>()
  private searchRun = 0
  private speechRange: { index: number; range: Range } | null = null
  private last: { index: number; range: Range | null; location: string; fraction: number } | null =
    null
  private wheelLock = 0
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
    if (book.splitTOCHref && book.getTOCFragment) {
      this.tocProgress = new TOCProgress()
      await this.tocProgress.init({
        toc: book.toc ?? [],
        ids: book.sections.map(section => section.id),
        splitHref: book.splitTOCHref.bind(book),
        getFragment: book.getTOCFragment.bind(book),
      })
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
    this.toc = convert(book.toc)

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
    renderer.setStyles?.(contentCSS(this.appearance))
  }

  private styleDocument(doc: Document): void {
    if (!doc?.body) return
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
    doc.documentElement.lang ||= this.language
    if (book.dir === 'rtl') doc.documentElement.dir ||= 'rtl'
    this.options.prepare?.(doc, index)
    this.styleDocument(doc)
    this.renderMath(doc, index)

    doc.addEventListener('click', event => {
      const target = event.target as Element | null
      const link = target?.closest?.('a[href]')
      if (link) {
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
    doc.addEventListener('keydown', event => this.events.keydown(event))
    // Dragging links and pictures out of the page only gets in the way of selecting.
    doc.addEventListener('dragstart', event => event.preventDefault())
    doc.addEventListener('wheel', this.onWheel, { passive: false })
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

  private onRelocate({ range, index, fraction = 0, size }: RelocateDetail): void {
    const progress = this.sectionProgress.getProgress(index, fraction, size)
    const tocItem = this.tocProgress?.getProgress(index, range ?? undefined)
    const location = this.locator.toLocation(index, range ?? null)
    const bookFraction = Number.isFinite(progress.fraction) ? progress.fraction : 0
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
      page: this.reflowable
        ? { current: progress.location.current + 1, total: progress.location.total, unit: 'loc' }
        : { current: index + 1, total: this.book.sections.length, unit: 'page' },
      excerpt,
    })
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
      await this.renderer.goTo(resolved)
    } catch (error) {
      console.warn(`Could not go to ${target}:`, error)
    }
  }

  async goToFraction(fraction: number): Promise<void> {
    const [index, inSection] = this.sectionProgress.getSection(fraction)
    await this.renderer?.goTo({ index, anchor: inSection })
  }

  next(): void {
    void this.renderer?.next()
  }

  prev(): void {
    void this.renderer?.prev()
  }

  step(direction: 1 | -1): void {
    const distance = this.flow === 'scrolled' ? 72 : undefined
    void (direction > 0 ? this.renderer?.next(distance) : this.renderer?.prev(distance))
  }

  goToEdge(edge: 'start' | 'end'): void {
    const { sections } = this.book
    const linear = (section: { linear?: string }) => section.linear !== 'no'
    if (edge === 'start') void this.renderer?.goTo({ index: Math.max(0, sections.findIndex(linear)) })
    else void this.renderer?.goTo({ index: sections.findLastIndex(linear), anchor: 1 })
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
    await this.renderer.goTo(resolved)
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
        overlayer.add(SEARCH_KEY + target, range, Overlayer.outline, {
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

  clearSearch(): void {
    this.searchRun++
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
