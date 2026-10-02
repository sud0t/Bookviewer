/**
 * The PDF engine: pdf.js's viewer component (continuous scroll, text layer)
 * plus our own highlight overlays, outline, search list and progress.
 */
import {
  bookUrl,
  type Annotation,
  type Book,
  type PdfRect,
  type Settings,
} from '@shared/types'
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist'
// The viewer components read pdf.js off `globalThis.pdfjsLib` as they load,
// so the library itself (imported by ./pdfjs) has to be evaluated first.
import { loadPdf } from './pdfjs'
import {
  HYPHENATED,
  findInLayer,
  fitScale,
  layerText,
  pageAtFraction,
  usualPageSize,
  zoomStep,
  type PageSize,
} from './pdf-text'
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import './pdf.css'
import { describeRange } from '../annotations/anchor'
import { fileName, openFailure } from './formats'
import { PALETTES } from './appearance'
import { mergeRects } from './rects'
import {
  HIGHLIGHT_HEX,
  type Appearance,
  type Engine,
  type EngineEvents,
  type Relocation,
  type SearchHit,
  type SearchOptions,
  type SearchUpdate,
  type SpeechSegment,
  type TocItem,
  type ViewportRect,
} from './types'

interface OutlineNode {
  title: string
  dest: string | unknown[] | null
  url: string | null
  items: OutlineNode[]
}

interface PageViewLike {
  id: number
  div: HTMLDivElement
  /** The zoom the view is drawn at (its viewport is this times the CSS-pixel size of a point). */
  scale: number
  pdfPage: PDFPageProxy | null
  setPdfPage(page: PDFPageProxy): void
  viewport: {
    width: number
    height: number
    viewBox: number[]
    convertToPdfPoint(x: number, y: number): number[]
    convertToViewportPoint(x: number, y: number): number[]
  }
  textLayer?: { div: HTMLDivElement } | null
}

interface PdfLocation {
  page: number
  left?: number | null
  top?: number | null
}

interface TextItemLike {
  str: string
  hasEOL: boolean
  transform: number[]
  height: number
}

interface PageText {
  text: string
  /** For every item: where it starts in `text`, and where it sits on the page. */
  items: { start: number; x: number; y: number }[]
}

type Target = { dest: string | unknown[] } | PdfLocation

const DEFAULT_SCALE: Settings['pdfZoom'] = 'page-width'
/** How long opening waits for the sizes of all pages before showing the book without them. */
const PAGE_SIZES_WAIT = 1500
const OVERLAY_CLASS = 'bv-pdf-overlay'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export class PdfEngine implements Engine {
  toc: TocItem[] = []
  chapterStarts: number[] = []
  readonly reflowable = false
  language = ''

  private task: PDFDocumentLoadingTask | null = null
  private pdf: PDFDocumentProxy | null = null
  private viewer: PDFViewer | null = null
  private eventBus = new EventBus()
  private linkService: PDFLinkService | null = null
  private container: HTMLDivElement | null = null
  private appearance!: Appearance
  private annotations: Annotation[] = []
  private tocPages: { id: string; label: string; page: number }[] = []
  private pages: (PDFPageProxy | undefined)[] = []
  private usualSize: PageSize | null = null
  private texts = new Map<number, Promise<PageText>>()
  private searchRun = 0
  private speechMark: { page: number; rects: PdfRect[] } | null = null
  private resizeObserver: ResizeObserver | null = null
  private scale: Settings['pdfZoom'] = DEFAULT_SCALE
  private last: PdfLocation = { page: 1 }
  private destroyed = false
  private abort = new AbortController()

  constructor(
    private book: Book,
    private events: EngineEvents,
  ) {}

  async open(
    host: HTMLElement,
    init: { location: string | null; appearance: Appearance; annotations: Annotation[] },
  ): Promise<void> {
    this.appearance = init.appearance
    this.annotations = init.annotations
    this.scale = init.appearance.settings.pdfZoom

    // pdf.js insists on an absolutely positioned scroll container.
    const container = document.createElement('div')
    container.className = 'bv-pdf'
    container.tabIndex = -1
    const viewerElement = document.createElement('div')
    viewerElement.className = 'pdfViewer'
    container.append(viewerElement)
    host.replaceChildren(container)
    this.container = container
    this.applyTheme()

    const { eventBus } = this
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      // following a link should not change the zoom the reader chose
      ignoreDestinationZoom: true,
    })
    const findController = new PDFFindController({ eventBus, linkService })
    const viewer = new PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      textLayerMode: 1,
      // links, but no form widgets or scripting
      annotationMode: 1,
      removePageBorders: false,
    })
    linkService.setViewer(viewer)
    this.viewer = viewer
    this.linkService = linkService

    this.task = loadPdf(bookUrl(this.book.id, fileName(this.book.path)))
    const start = this.parseLocation(init.location)
    let pdf: PDFDocumentProxy
    let sizes: { rest: Promise<void> }
    try {
      pdf = await this.task.promise
      sizes = await this.loadPages(pdf, start?.page ?? 1)
    } catch (error) {
      throw openFailure(error, this.book.path)
    }
    if (this.destroyed) return
    this.pdf = pdf

    const ready = new Promise<void>(resolve => {
      eventBus.on(
        'pagesinit',
        () => {
          // In this order, and before pdf.js draws anything: the zoom and
          // the place both depend on the pages having their real sizes.
          this.sizePages()
          this.applyScale()
          if (start) void this.scrollTo(start)
          resolve()
        },
        { once: true },
      )
    })
    viewer.setDocument(pdf)
    linkService.setDocument(pdf, null)
    await ready
    // Sizes that took longer than the wait: lay the book out again around
    // the place being read.
    void sizes.rest.then(() => {
      if (this.destroyed || !this.sizePages()) return
      this.applyScale()
      void this.scrollTo(this.last)
    })

    eventBus.on('updateviewarea', ({ location }: { location: PdfLocation & { pageNumber: number } }) => {
      this.last = { page: location.pageNumber, left: location.left, top: location.top }
      this.emitRelocate()
    })
    eventBus.on('pagerendered', ({ pageNumber }: { pageNumber: number }) => this.drawPage(pageNumber))
    eventBus.on('textlayerrendered', ({ pageNumber }: { pageNumber: number }) =>
      this.drawPage(pageNumber),
    )

    const { signal } = this.abort
    container.addEventListener('pointerup', () => setTimeout(() => this.reportSelection()), { signal })
    container.addEventListener('click', event => this.onClick(event), { signal })
    container.addEventListener('wheel', event => this.onWheel(event), { passive: false, signal })
    document.addEventListener(
      'selectionchange',
      () => {
        if (document.getSelection()?.isCollapsed) this.events.selection(null)
      },
      { signal },
    )
    let width = container.clientWidth
    let height = container.clientHeight
    this.resizeObserver = new ResizeObserver(() => {
      const wider = container.clientWidth !== width
      const taller = container.clientHeight !== height
      width = container.clientWidth
      height = container.clientHeight
      // Fit modes follow the window (fitting the width does not care how
      // tall it is); fixed zoom levels stay put.
      if (typeof this.scale === 'number' || !(wider || (taller && this.scale !== 'page-width'))) return
      this.applyScale()
    })
    this.resizeObserver.observe(container)

    void this.loadOutline()
    void pdf
      .getMetadata()
      .then(({ info }) => {
        const language = (info as { Language?: unknown }).Language
        if (typeof language === 'string') this.language = language
      })
      .catch(() => {})
    this.last = start ?? { page: 1 }
    this.emitRelocate()
  }

  destroy(): void {
    this.destroyed = true
    this.searchRun++
    this.abort.abort()
    this.resizeObserver?.disconnect()
    // Detaching the document is what makes pdf.js let go of rendered pages
    // (their canvases, text layers and the listeners those register).
    try {
      this.viewer?.setDocument(null as never)
      this.linkService?.setDocument(null, null)
    } catch {
      // already torn down
    }
    this.container?.remove()
    void this.task?.destroy()
  }

  /* ---------- page sizes ---------- */

  /**
   * Asks for every page, which is how its size becomes known. pdf.js would
   * only do that as pages are scrolled to, assuming the first page's size
   * until then - and a book whose cover is smaller than the rest is then
   * fitted to the window, and laid out, by the wrong size. This is quick
   * (tens of milliseconds for a thousand pages), but a huge or slow file is
   * only waited for as far as the page the book opens on, which is what the
   * saved place is measured against: `rest` settles when everything is in.
   */
  private async loadPages(pdf: PDFDocumentProxy, opensOn: number): Promise<{ rest: Promise<void> }> {
    // (a file whose first page cannot be read has nothing to show at all)
    this.pages = [await pdf.getPage(1)]
    const load = (number: number): Promise<void> =>
      pdf.getPage(number).then(
        page => {
          this.pages[number - 1] = page
        },
        () => {
          // a broken page keeps the size pdf.js assumes for it
        },
      )
    const all = Promise.all(Array.from({ length: pdf.numPages - 1 }, (_, index) => load(index + 2))).then(() => {})
    if (opensOn > 1 && opensOn <= pdf.numPages) await load(opensOn)
    await Promise.race([all, new Promise(resolve => setTimeout(resolve, PAGE_SIZES_WAIT))])
    return { rest: all }
  }

  /** Gives the page views the sizes known by now. True if that changed any. */
  private sizePages(): boolean {
    const viewer = this.viewer
    if (!viewer) return false
    let changed = false
    for (let index = 0; index < viewer.pagesCount; index++) {
      const page = this.pages[index]
      const view = viewer.getPageView(index) as PageViewLike | undefined
      if (!page || !view || view.pdfPage) continue
      view.setPdfPage(page)
      changed = true
    }
    if (changed) this.usualSize = null
    return changed
  }

  /**
   * Puts the chosen zoom into effect. The fit modes go by the book's usual
   * page size rather than, as pdf.js has it, by the page in view. pdf.js
   * keeps the top left corner of the view where it is.
   */
  private applyScale(): void {
    const { viewer, container, scale } = this
    if (!viewer?.pagesCount || !container) return
    if (typeof scale === 'number') {
      viewer.currentScale = scale
      return
    }
    this.usualSize ??= usualPageSize(
      Array.from({ length: viewer.pagesCount }, (_, index) => {
        const view = viewer.getPageView(index) as PageViewLike
        return { width: view.viewport.width / view.scale, height: view.viewport.height / view.scale }
      }),
    )
    const fitted = fitScale(scale, this.usualSize, { width: container.clientWidth, height: container.clientHeight })
    if (Number.isFinite(fitted) && fitted > 0) viewer.currentScale = fitted
    else viewer.currentScaleValue = scale
  }

  /* ---------- outline ---------- */

  private async loadOutline(): Promise<void> {
    const pdf = this.pdf
    if (!pdf) return
    const outline = ((await pdf.getOutline().catch(() => null)) ?? []) as OutlineNode[]
    let nextId = 0
    const pages: Promise<void>[] = []
    const convert = (nodes: OutlineNode[]): TocItem[] =>
      nodes.map(node => {
        const id = String(nextId++)
        const label = node.title?.trim() || 'Untitled'
        if (node.dest)
          pages.push(
            this.pageOfDest(node.dest).then(page => {
              if (page) this.tocPages.push({ id, label, page })
            }),
          )
        return {
          id,
          label,
          target: node.dest ? JSON.stringify({ dest: node.dest }) : null,
          children: convert(node.items ?? []),
        }
      })
    this.toc = convert(outline)
    await Promise.all(pages)
    this.tocPages.sort((a, b) => a.page - b.page || Number(a.id) - Number(b.id))
    const total = this.viewer?.pagesCount || 1
    const top = new Set(this.toc.map(item => item.id))
    this.chapterStarts = [
      ...new Set(this.tocPages.filter(item => top.has(item.id) && item.page > 1).map(item => (item.page - 1) / total)),
    ]
    if (!this.destroyed) this.emitRelocate()
  }

  private async pageOfDest(dest: string | unknown[]): Promise<number | null> {
    const pdf = this.pdf
    if (!pdf) return null
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
      const ref = explicit?.[0]
      if (typeof ref === 'number') return ref + 1
      if (ref && typeof ref === 'object')
        return (await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])) + 1
    } catch {
      // a dangling destination
    }
    return null
  }

  private tocAt(page: number): { id: string; label: string } | null {
    let found: { id: string; label: string } | null = null
    for (const item of this.tocPages) {
      if (item.page > page) break
      found = item
    }
    return found
  }

  /* ---------- location ---------- */

  private parseLocation(location: string | null): PdfLocation | null {
    if (!location) return null
    try {
      const parsed = JSON.parse(location) as PdfLocation
      return Number.isInteger(parsed.page) && parsed.page >= 1 ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * Makes sure a page is laid out at its own size. pdf.js gives every page
   * the size of the first until it has loaded it, and a place inside a page
   * worked out from the wrong size is off by the difference.
   */
  private async measure(page: number): Promise<void> {
    const view = this.pageView(page)
    if (!view || view.pdfPage || !this.pdf) return
    const loaded = await this.pdf.getPage(page).catch(() => null)
    if (loaded && !view.pdfPage && !this.destroyed) view.setPdfPage(loaded)
  }

  private async scrollTo({ page, left, top }: PdfLocation): Promise<void> {
    const viewer = this.viewer
    if (!viewer) return
    const pageNumber = Math.min(Math.max(1, page), viewer.pagesCount)
    if (top != null) await this.measure(pageNumber)
    if (this.destroyed) return
    viewer.scrollPageIntoView({
      pageNumber,
      destArray: top == null ? undefined : [null, { name: 'XYZ' }, left ?? null, top, null],
      allowNegativeOffset: true,
    })
  }

  private pageView(page: number): PageViewLike | null {
    return (this.viewer?.getPageView(page - 1) as PageViewLike | undefined) ?? null
  }

  /** How far the top of the viewport is through the given page, 0..1. */
  private fractionInPage(page: number): number {
    const view = this.pageView(page)
    const container = this.container
    if (!view || !container) return 0
    const offset = container.scrollTop - view.div.offsetTop
    return Math.min(0.999, Math.max(0, offset / Math.max(1, view.div.offsetHeight)))
  }

  private emitRelocate(): void {
    const viewer = this.viewer
    if (!viewer || this.destroyed) return
    const total = viewer.pagesCount || 1
    const { page } = this.last
    const toc = this.tocAt(page)
    const text = this.texts.get(page)
    const container = this.container
    // (the top of the view never gets to the end of the last page)
    const atEnd =
      !!container && container.scrollTop + container.clientHeight >= container.scrollHeight - 1
    const relocate = (excerpt: string) =>
      this.events.relocate({
        fraction: atEnd ? 1 : Math.min(1, (page - 1 + this.fractionInPage(page)) / total),
        location: JSON.stringify(this.last),
        tocId: toc?.id ?? null,
        label: toc?.label ?? '',
        // (the page that fills the view, which need not be the one a sliver
        // of which is left at the top edge)
        page: { current: viewer.currentPageNumber || page, total, unit: 'page' },
        excerpt,
      })
    relocate('')
    // The excerpt is only for bookmarks; fill it in once the text is known.
    void (text ?? this.pageText(page)).then(({ text: content }) => {
      if (this.last.page === page && !this.destroyed) relocate(content.trim().slice(0, 140))
    })
  }

  async goTo(target: string): Promise<void> {
    let parsed: Target
    try {
      parsed = JSON.parse(target) as Target
    } catch {
      return
    }
    if ('dest' in parsed) await this.linkService?.goToDestination(parsed.dest as string)
    else if (Number.isInteger(parsed.page)) await this.scrollTo(parsed)
  }

  async goToFraction(fraction: number): Promise<void> {
    const viewer = this.viewer
    const container = this.container
    if (!viewer || !container) return
    const { page, within } = pageAtFraction(fraction, viewer.pagesCount)
    const view = this.pageView(page)
    if (!view) return
    container.scrollTop = view.div.offsetTop + within * view.div.offsetHeight
  }

  describe(fraction: number): { label: string; page: Relocation['page'] } {
    const total = this.viewer?.pagesCount || 1
    const { page } = pageAtFraction(fraction, total)
    return { label: this.tocAt(page)?.label ?? '', page: { current: page, total, unit: 'page' } }
  }

  /**
   * Whether the spot a bookmark was made at is on screen - or, as in the
   * scroller, still less than a good part of a screen above it.
   */
  isInView(location: string): boolean {
    const target = this.parseLocation(location)
    const container = this.container
    const view = target && this.pageView(target.page)
    if (!target || !container || !view) return false
    let y = view.div.offsetTop + view.div.clientTop
    if (target.top != null) y += view.viewport.convertToViewportPoint(target.left ?? 0, target.top)[1]
    const { scrollTop, clientHeight } = container
    return y >= scrollTop - clientHeight * 0.4 && y < scrollTop + clientHeight
  }

  private scrollBy(amount: number, smooth: boolean): void {
    this.container?.scrollBy({ top: amount, behavior: smooth ? 'smooth' : 'auto' })
  }

  next(): void {
    this.scrollBy((this.container?.clientHeight ?? 600) - 60, true)
  }

  prev(): void {
    this.scrollBy(-((this.container?.clientHeight ?? 600) - 60), true)
  }

  step(direction: 1 | -1): void {
    this.scrollBy(direction * 72, false)
  }

  goToEdge(edge: 'start' | 'end'): void {
    if (this.viewer) void this.scrollTo({ page: edge === 'start' ? 1 : this.viewer.pagesCount })
  }

  flush(): void {
    // nothing to catch up on: pdf.js reports a scroll within a frame
  }

  settled(): Promise<void> {
    return Promise.resolve()
  }

  focus(): void {
    this.container?.focus({ preventScroll: true })
  }

  /* ---------- appearance ---------- */

  private applyTheme(): void {
    const container = this.container
    if (!container) return
    const { settings, theme } = this.appearance
    const themed = settings.pdfThemed
    container.dataset.tint = !themed ? 'none' : PALETTES[theme].invert ? 'dark' : theme
    container.style.setProperty('--bv-pdf-bg', PALETTES[theme].invert ? '#111' : '')
  }

  setAppearance(appearance: Appearance): void {
    const zoom = appearance.settings.pdfZoom
    this.appearance = appearance
    this.applyTheme()
    // (a zoom made here, with zoom() or the wheel, comes back as a setting:
    // it is in effect already)
    if (zoom === this.scale) return
    this.scale = zoom
    this.applyScale()
  }

  zoom(direction: 1 | -1 | 0): void {
    const viewer = this.viewer
    if (!viewer) return
    // a step is taken from the zoom in effect, whatever fit mode produced it
    this.scale = direction === 0 ? DEFAULT_SCALE : zoomStep(viewer.currentScale, direction)
    this.applyScale()
    // keep the settings (and the zoom menu) in step
    this.events.settings({ pdfZoom: this.scale })
  }

  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey || !this.viewer) return
    event.preventDefault()
    this.zoom(event.deltaY < 0 ? 1 : -1)
  }

  /* ---------- selection and annotations ---------- */

  private pageOfNode(node: Node | null): number | null {
    const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement
    const page = element?.closest<HTMLElement>('.page')
    return page?.dataset.pageNumber ? Number(page.dataset.pageNumber) : null
  }

  /** Rectangles (in PDF units) of the text a range covers on one page. */
  private rectsOf(range: Range, view: PageViewLike): PdfRect[] {
    const layer = view.textLayer?.div
    if (!layer) return []
    const origin = view.div.getBoundingClientRect()
    // The page's border offsets its content box from the bounding rect.
    const left = origin.left + view.div.clientLeft
    const top = origin.top + view.div.clientTop
    const rects: PdfRect[] = []
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node) || !node.nodeValue?.trim()) continue
      const part = document.createRange()
      part.selectNodeContents(node)
      if (node === range.startContainer) part.setStart(node, range.startOffset)
      if (node === range.endContainer) part.setEnd(node, range.endOffset)
      for (const rect of part.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue
        const [x1, y1] = view.viewport.convertToPdfPoint(rect.left - left, rect.top - top)
        const [x2, y2] = view.viewport.convertToPdfPoint(rect.right - left, rect.bottom - top)
        rects.push([x1, y1, x2, y2])
      }
    }
    return mergeRects(rects)
  }

  private reportSelection(): void {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!this.container?.contains(range.commonAncestorContainer)) return
    const page = this.pageOfNode(range.startContainer)
    const view = page ? this.pageView(page) : null
    const layer = view?.textLayer?.div
    if (!page || !view || !layer) return
    // A highlight lives on one page: clip a longer selection to where it starts.
    const clipped = range.cloneRange()
    if (!layer.contains(range.endContainer)) clipped.setEnd(layer, layer.childNodes.length)
    const rects = this.rectsOf(clipped, view)
    const described = describeRange(layer, clipped)
    const text = layerText(layer, clipped)
    if (!rects.length || !described || !text) return
    const total = this.viewer?.pagesCount || 1
    const bounds = clipped.getBoundingClientRect()
    // how far down the page (as displayed, whatever its rotation) it starts
    const [, top] = view.viewport.convertToViewportPoint(rects[0][0], rects[0][3])
    const inPage = Math.min(0.999, Math.max(0, top / Math.max(1, view.viewport.height)))
    this.events.selection({
      text,
      selector: { type: 'pdf', page, rects, quote: described.quote },
      label: this.tocAt(page)?.label ?? `Page ${page}`,
      position: (page - 1 + inPage) / total,
      rect: bounds,
      language: this.language,
    })
  }

  /** The page's height in PDF units. */
  private pageHeight(view: PageViewLike): number {
    const [, y1, , y2] = view.viewport.viewBox
    return Math.abs(y2 - y1) || 792
  }

  /** A PDF-space rectangle as CSS percentages of its page. */
  private percentRect(view: PageViewLike, rect: PdfRect) {
    const [x1, y1] = view.viewport.convertToViewportPoint(rect[0], rect[1])
    const [x2, y2] = view.viewport.convertToViewportPoint(rect[2], rect[3])
    const { width, height } = view.viewport
    return {
      left: (Math.min(x1, x2) / width) * 100,
      top: (Math.min(y1, y2) / height) * 100,
      width: (Math.abs(x2 - x1) / width) * 100,
      height: (Math.abs(y2 - y1) / height) * 100,
    }
  }

  private drawPage(page: number): void {
    const view = this.pageView(page)
    if (!view?.div.isConnected) return
    let overlay = view.div.querySelector<HTMLDivElement>(`:scope > .${OVERLAY_CLASS}`)
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.className = OVERLAY_CLASS
      // Above the canvas, below the text layer (so text stays selectable).
      const textLayer = view.div.querySelector(':scope > .textLayer')
      if (textLayer) view.div.insertBefore(overlay, textLayer)
      else view.div.append(overlay)
    }
    const marks: HTMLElement[] = []
    const add = (rect: PdfRect, className: string, color: string, id?: number) => {
      const mark = document.createElement('div')
      const box = this.percentRect(view, rect)
      mark.className = className
      mark.style.cssText = `left:${box.left}%;top:${box.top}%;width:${box.width}%;height:${box.height}%;--color:${color}`
      if (id != null) mark.dataset.id = String(id)
      marks.push(mark)
    }
    for (const annotation of this.annotations) {
      if (annotation.selector.type !== 'pdf' || annotation.selector.page !== page) continue
      const color = HIGHLIGHT_HEX[annotation.color] ?? HIGHLIGHT_HEX.yellow
      for (const rect of annotation.selector.rects)
        add(rect, `bv-mark bv-${annotation.style}`, color, annotation.id)
    }
    if (this.speechMark?.page === page)
      for (const rect of this.speechMark.rects) add(rect, 'bv-mark bv-speech', '#3b82f6')
    overlay.replaceChildren(...marks)
  }

  private redraw(): void {
    for (const view of (this.viewer?.getCachedPageViews() ?? []) as Set<PageViewLike>)
      this.drawPage(view.id)
  }

  setAnnotations(annotations: Annotation[]): void {
    this.annotations = annotations
    this.redraw()
  }

  private annotationRect(annotation: Annotation): ViewportRect | null {
    if (annotation.selector.type !== 'pdf') return null
    const view = this.pageView(annotation.selector.page)
    if (!view) return null
    const page = view.div.getBoundingClientRect()
    const boxes = annotation.selector.rects.map(rect => this.percentRect(view, rect))
    if (!boxes.length) return null
    const width = view.div.clientWidth
    const height = view.div.clientHeight
    const originX = page.left + view.div.clientLeft
    const originY = page.top + view.div.clientTop
    return {
      left: originX + (Math.min(...boxes.map(b => b.left)) / 100) * width,
      top: originY + (Math.min(...boxes.map(b => b.top)) / 100) * height,
      right: originX + (Math.max(...boxes.map(b => b.left + b.width)) / 100) * width,
      bottom: originY + (Math.max(...boxes.map(b => b.top + b.height)) / 100) * height,
    }
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as Element
    const link = target.closest('a')
    if (link) {
      // a link within the document: remember where we came from
      if (link.getAttribute('target') !== '_blank') this.events.jump()
      return
    }
    if (!document.getSelection()?.isCollapsed) return
    // The text layer sits on top of the highlights, so hit-test by position.
    const pageElement = target.closest<HTMLElement>('.page')
    const marks = pageElement?.querySelectorAll<HTMLElement>(`.${OVERLAY_CLASS} .bv-mark[data-id]`)
    for (const mark of marks ?? []) {
      const box = mark.getBoundingClientRect()
      if (
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      ) {
        const annotation = this.annotations.find(a => a.id === Number(mark.dataset.id))
        const rect = annotation ? this.annotationRect(annotation) : null
        if (annotation && rect) {
          this.events.annotationClick(annotation.id, rect)
          return
        }
      }
    }
    this.events.click()
  }

  async showAnnotation(annotation: Annotation): Promise<void> {
    if (annotation.selector.type !== 'pdf') return
    const { page, rects } = annotation.selector
    const top = Math.max(...rects.map(rect => rect[3]))
    const left = Math.min(...rects.map(rect => rect[0]))
    const view = this.pageView(page)
    // Leave some room above the highlight.
    await this.scrollTo({ page, left: left - 40, top: top + (view ? this.pageHeight(view) * 0.12 : 80) })
    await new Promise(resolve => setTimeout(resolve, 120))
    const rect = this.annotationRect(annotation)
    if (rect) this.events.annotationClick(annotation.id, rect)
  }

  clearSelection(): void {
    document.getSelection()?.removeAllRanges()
  }

  /* ---------- text, search and speech ---------- */

  private pageText(page: number): Promise<PageText> {
    let text = this.texts.get(page)
    if (!text) {
      text = (async () => {
        const proxy = await this.pdf!.getPage(page)
        const content = await proxy.getTextContent()
        const result: PageText = { text: '', items: [] }
        for (const item of content.items as TextItemLike[]) {
          if (typeof item.str !== 'string') continue
          result.items.push({
            start: result.text.length,
            x: item.transform[4],
            y: item.transform[5] + item.height,
          })
          result.text += item.str
          if (item.hasEOL) {
            // Re-join words that were hyphenated across a line break.
            if (HYPHENATED.test(result.text) && item.str.length > 1)
              result.text = result.text.slice(0, -1)
            else result.text += ' '
          }
        }
        return result
      })()
      this.texts.set(page, text)
    }
    return text
  }

  async *search(query: string, options: SearchOptions): AsyncGenerator<SearchUpdate> {
    this.clearSearch()
    const run = this.searchRun
    const viewer = this.viewer
    if (!viewer || !this.pdf) return
    // pdf.js highlights the matches inside the pages (and moves to the first)...
    this.events.jump()
    this.eventBus.dispatch('find', {
      source: this,
      type: '',
      query,
      caseSensitive: options.matchCase,
      entireWord: options.wholeWords,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: false,
    })
    // ...and we collect them into a list.
    const pattern = new RegExp(
      options.wholeWords
        ? `(?<![\\p{L}\\p{N}_])${escapeRegExp(query)}(?![\\p{L}\\p{N}_])`
        : escapeRegExp(query).replace(/\s+/g, '\\s+'),
      options.matchCase ? 'gu' : 'giu',
    )
    const total = viewer.pagesCount
    for (let page = 1; page <= total; page++) {
      if (run !== this.searchRun || this.destroyed) return
      const { text, items } = await this.pageText(page).catch((): PageText => ({ text: '', items: [] }))
      if (run !== this.searchRun) return
      const hits: SearchHit[] = []
      for (const match of text.matchAll(pattern)) {
        const at = match.index
        let item = items[0]
        for (const candidate of items) {
          if (candidate.start > at) break
          item = candidate
        }
        const location: PdfLocation = { page, left: null, top: item ? item.y + 60 : null }
        hits.push({
          target: JSON.stringify(location),
          pre: (at > 40 ? '…' : '') + text.slice(Math.max(0, at - 40), at),
          match: match[0],
          post: text.slice(at + match[0].length, at + match[0].length + 60).trimEnd() + '…',
        })
        if (hits.length >= 200) break
      }
      if (hits.length) {
        const toc = this.tocAt(page)
        yield { group: { label: toc ? `${toc.label} · page ${page}` : `Page ${page}`, hits } }
      }
      if (page % 8 === 0 || page === total) yield { progress: page / total }
    }
  }

  clearSearch(): void {
    this.searchRun++
    this.eventBus.dispatch('findbarclose', { source: this })
  }

  /** Marks a sentence on its page, once that page's text layer exists. */
  private async markSpeech(page: number, sentence: string): Promise<void> {
    this.speechMark = null
    for (let attempt = 0; attempt < 20; attempt++) {
      const view = this.pageView(page)
      const layer = view?.textLayer?.div
      if (view && layer?.childElementCount) {
        const range = findInLayer(layer, sentence)
        const rects = range ? this.rectsOf(range, view) : []
        if (rects.length) this.speechMark = { page, rects }
        this.redraw()
        if (!rects.length) return
        const top = Math.max(...rects.map(rect => rect[3]))
        const box = this.annotationRect({
          selector: { type: 'pdf', page, rects, quote: { exact: '', prefix: '', suffix: '' } },
        } as Annotation)
        const container = this.container
        // Only scroll when the sentence is leaving the comfortable zone.
        if (box && container) {
          const frame = container.getBoundingClientRect()
          if (box.top < frame.top + 20 || box.bottom > frame.bottom - frame.height * 0.25)
            void this.scrollTo({ page, top: top + this.pageHeight(view) * 0.15 })
        }
        return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
      if (this.destroyed) return
    }
    // the page never rendered: at least take the previous sentence's mark away
    this.redraw()
  }

  async *speech(): AsyncGenerator<SpeechSegment[]> {
    const viewer = this.viewer
    if (!viewer) return
    let segmenter: Intl.Segmenter
    try {
      segmenter = new Intl.Segmenter(this.language || 'en', { granularity: 'sentence' })
    } catch {
      segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
    }
    // Start with a selection if there is one.
    const selection = document.getSelection()
    let from = ''
    let page = this.last.page
    if (selection && !selection.isCollapsed && this.container?.contains(selection.anchorNode)) {
      page = this.pageOfNode(selection.getRangeAt(0).startContainer) ?? page
      from = selection.toString().replace(/\s+/g, ' ').trim().slice(0, 40)
      selection.removeAllRanges()
    }
    for (; page <= viewer.pagesCount && !this.destroyed; page++) {
      const { text } = await this.pageText(page)
      const offset = from ? Math.max(0, text.replace(/\s+/g, ' ').indexOf(from)) : 0
      from = ''
      const current = page
      const batch: SpeechSegment[] = []
      for (const { segment, index } of segmenter.segment(text)) {
        const sentence = segment.replace(/\s+/g, ' ').trim()
        if (index + segment.length <= offset || !/[\p{L}\p{N}]/u.test(sentence)) continue
        batch.push({
          text: sentence,
          language: this.language || 'en',
          show: () => {
            if (this.last.page !== current && !this.pageView(current)?.textLayer?.div.childElementCount)
              void this.scrollTo({ page: current })
            void this.markSpeech(current, sentence)
          },
        })
      }
      if (batch.length) yield batch
    }
  }

  clearSpeechMark(): void {
    this.speechMark = null
    this.redraw()
  }
}
