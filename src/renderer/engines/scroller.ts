/**
 * A continuous-scroll renderer. foliate-js's paginator shows one section
 * (chapter, page of a site) at a time even in scrolled mode; this stitches
 * the sections into a single column instead, loading the ones around the
 * viewport and dropping those far behind, so a whole book reads as one page.
 *
 * It implements the same interface as foliate's renderers (see README there):
 * `open`, `goTo`, `next`, `prev`, `getContents`, `setStyles` and the `load`,
 * `relocate` and `create-overlayer` events.
 */
import type { Anchor, FoliateBook, FoliateSection } from 'foliate-js/types'

interface OverlayerLike {
  element: Element
  redraw(): void
}

interface View {
  index: number
  element: HTMLDivElement
  iframe: HTMLIFrameElement
  doc: Document | null
  overlayer: OverlayerLike | null
  observer: ResizeObserver | null
  layoutStyle: HTMLStyleElement | null
  userStyle: HTMLStyleElement | null
  height: number
  ready: Promise<void>
  dead: boolean
  /** Height changes in the current burst (see #expand). */
  resizes: number
  resizeBurst: number
  /** Settles a load that will never finish because the view was removed. */
  cancel: (() => void) | null
}

type Target = Range | Element | number | null | undefined

/** How many viewport heights of content to keep loaded beyond the viewport. */
const AHEAD = 2
/** Views further than this many viewport heights away are unloaded. */
const KEEP = 5
/** Room left above what `goTo` scrolls to. */
const TOP_MARGIN = 24
/** The line reported as the position is the one this far below that margin. */
const READING_LINE = 4

const isRange = (value: unknown): value is Range =>
  !!value && typeof (value as Range).getClientRects === 'function' && 'startContainer' in (value as object)
const isElement = (value: unknown): value is Element =>
  !!value && (value as Node).nodeType === 1

export class Scroller extends HTMLElement {
  static observedAttributes = ['max-inline-size', 'margin']

  #root = this.attachShadow({ mode: 'open' })
  #container: HTMLDivElement
  #column: HTMLDivElement
  #sections: FoliateSection[] = []
  #views: View[] = []
  #styles = ''
  #anchor: {
    view: View
    target: Element | Range | null
    position: number
    offset: number
    /** Set after a navigation, until the reader scrolls: shows its target again. */
    again?: () => void
  } | null = null
  /** Where #restoreAnchor last put the viewport (to recognise its own scroll event). */
  #restoredTo = -1
  #generation = 0
  #filling = false
  #fillQueued = false
  #relocateTimer: ReturnType<typeof setTimeout> | undefined
  #resizeObserver = new ResizeObserver(() => this.#onResize())
  #width = 0
  #destroyed = false

  constructor() {
    super()
    this.#root.innerHTML = `<style>
      :host {
        display: block;
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        --_max-inline-size: 760px;
        --_margin: 40px;
      }
      #container {
        position: absolute;
        inset: 0;
        overflow-x: hidden;
        overflow-y: auto;
        /* we keep the reading position ourselves (see #restoreAnchor) */
        overflow-anchor: none;
        scrollbar-width: none;
        background: var(--bv-bg, transparent);
        outline: none;
      }
      #column {
        margin: 0 auto;
        max-width: calc(var(--_max-inline-size) + 2 * var(--_pad, 32px));
        padding: var(--_margin) 0 40vh;
      }
      .view {
        position: relative;
        width: 100%;
      }
      .view + .view {
        margin-top: 48px;
      }
      iframe {
        display: block;
        width: 100%;
        border: 0;
        filter: var(--bv-filter, none);
      }
    </style>
    <div id="container" tabindex="-1"><div id="column"></div></div>`
    this.#container = this.#root.getElementById('container') as HTMLDivElement
    this.#column = this.#root.getElementById('column') as HTMLDivElement
    this.#container.addEventListener('scroll', () => this.#onScroll(), { passive: true })
  }

  connectedCallback(): void {
    this.#resizeObserver.observe(this.#container)
  }

  disconnectedCallback(): void {
    this.#resizeObserver.disconnect()
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (value == null) return
    this.style.setProperty('--_' + name, value)
    if (name === 'max-inline-size') this.#relayout()
  }

  open(book: FoliateBook): void {
    this.#sections = book.sections
  }

  /* ---------- geometry ---------- */

  get #pad(): number {
    return Math.round(Math.min(48, Math.max(16, this.#container.clientWidth * 0.05)))
  }

  #top(view: View): number {
    return view.element.offsetTop
  }

  /** The view under the top edge of the viewport, or this far below it. */
  #current(below = 1): View | null {
    const { scrollTop } = this.#container
    for (const view of this.#views)
      if (this.#top(view) + view.element.offsetHeight > scrollTop + below) return view
    return this.#views.at(-1) ?? null
  }

  #adjacent(index: number, direction: 1 | -1): number | null {
    for (let i = index + direction; i >= 0 && i < this.#sections.length; i += direction)
      if (this.#sections[i].linear !== 'no') return i
    return null
  }

  /* ---------- keeping the reading position ---------- */

  /**
   * Remembers what is at the top of the viewport and where it sits in the
   * scrolled content, so that layout shifts above it (a chapter loaded or
   * unloaded, an image arriving, the text being resized) can be cancelled
   * out in #restoreAnchor. The anchor is a character of text where possible:
   * an element may be a wrapper as tall as the chapter, whose top says
   * nothing about the line being read.
   */
  #captureAnchor(): void {
    const view = this.#current()
    if (!view) {
      this.#anchor = null
      return
    }
    const { scrollTop, clientHeight } = this.#container
    const top = this.#top(view)
    let target: Element | Range | null = null
    const doc = view.doc
    if (doc?.documentElement) {
      const y = Math.max(0, scrollTop - top)
      const width = doc.documentElement.clientWidth
      const left = this.#pad + 8
      // Probe downwards until we land on real content rather than a margin.
      for (const dy of [2, 12, 28, 60, 120]) {
        let caret: Range | null = null
        try {
          caret = doc.caretRangeFromPoint(left, y + dy)
        } catch {
          caret = null
        }
        const node = caret?.startContainer
        if (caret && node?.nodeType === 3 && (node as Text).length) {
          const offset = Math.min(caret.startOffset, (node as Text).length - 1)
          caret.setStart(node, offset)
          caret.setEnd(node, offset + 1)
          // (a caret can snap to text far from the point; only take a near one)
          if (Math.abs(caret.getBoundingClientRect().top - (y + dy)) < 200) {
            target = caret
            break
          }
        }
        const hit = doc.elementFromPoint(width / 2, y + dy)
        if (
          hit &&
          hit !== doc.documentElement &&
          hit !== doc.body &&
          hit.getBoundingClientRect().height < clientHeight
        ) {
          target = hit
          break
        }
      }
    }
    const position = top + (target?.getBoundingClientRect().top ?? 0)
    // `offset` is where the anchor sits relative to the top of the viewport.
    this.#anchor = { view, target, position, offset: position - scrollTop }
  }

  #restoreAnchor(): void {
    const anchor = this.#anchor
    if (!anchor || anchor.view.dead || !anchor.view.element.isConnected) return
    // Straight after a navigation it is the target that has to stay put, and
    // it can be looked up again whatever happened to the document meanwhile
    // (formulas being rendered replace the very text the anchor is in).
    if (anchor.again) {
      anchor.again()
      return
    }
    const { target } = anchor
    const gone =
      target &&
      ('startContainer' in target
        ? !target.startContainer.isConnected || target.collapsed
        : !target.isConnected)
    if (gone) {
      // What we were holding on to is gone (formulas rendered or removed,
      // ...): there is nothing to measure against, so take a new bearing.
      this.#captureAnchor()
      return
    }
    const position = this.#top(anchor.view) + (target?.getBoundingClientRect().top ?? 0)
    // Nothing moved: leave the scroll position (and any smooth scroll) alone.
    if (Math.abs(position - anchor.position) < 1) return
    anchor.position = position
    // An absolute target rather than a nudge: when content above shrinks the
    // browser may already have clamped scrollTop.
    this.#container.scrollTop = position - anchor.offset
    this.#restoredTo = this.#container.scrollTop
  }

  /* ---------- views ---------- */

  #layoutCSS(): string {
    const pad = this.#pad
    return `
      html {
        box-sizing: border-box !important;
        width: auto !important;
        height: auto !important;
        min-height: 0 !important;
        max-width: none !important;
        margin: 0 !important;
        padding: 0 ${pad}px !important;
        border: 0 !important;
        overflow: hidden !important;
        column-width: auto !important;
        column-count: auto !important;
        position: static !important;
      }
      body {
        height: auto !important;
        min-height: 0 !important;
        max-width: none !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
        position: static !important;
        overflow: visible !important;
        overflow-wrap: break-word;
      }
    `
  }

  #createView(index: number, where: 'append' | 'prepend'): View {
    const element = document.createElement('div')
    element.className = 'view'
    const iframe = document.createElement('iframe')
    // Same-origin so that we can reach into the document, but no scripts.
    iframe.setAttribute('sandbox', 'allow-same-origin')
    iframe.setAttribute('scrolling', 'no')
    iframe.setAttribute('title', 'Book text')
    iframe.setAttribute('part', 'filter')
    // Until the real height is known, a screenful: `vh` units in the
    // content then come out as the reader's height, as they should.
    const initial = Math.max(200, this.#container.clientHeight)
    iframe.style.height = `${initial}px`
    element.append(iframe)

    const view: View = {
      index,
      element,
      iframe,
      doc: null,
      overlayer: null,
      observer: null,
      layoutStyle: null,
      userStyle: null,
      height: initial,
      ready: Promise.resolve(),
      dead: false,
      resizes: 0,
      resizeBurst: 0,
      cancel: null,
    }
    if (where === 'append') {
      this.#column.append(element)
      this.#views.push(view)
    } else {
      this.#column.prepend(element)
      this.#views.unshift(view)
    }
    view.ready = this.#loadView(view).catch(error => {
      console.warn(`Loading section ${index} failed:`, error)
    })
    return view
  }

  async #loadView(view: View): Promise<void> {
    const { iframe, index } = view
    const src = await this.#sections[index].load()
    if (view.dead) return
    await new Promise<void>(resolve => {
      // A frame taken out of the document mid-load never fires `load`.
      view.cancel = resolve
      iframe.addEventListener('load', () => resolve(), { once: true })
      iframe.src = src
    })
    view.cancel = null
    if (view.dead) return
    const doc = iframe.contentDocument
    if (!doc?.documentElement) return
    view.doc = doc

    const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.documentElement.firstChild)
    view.userStyle = doc.createElement('style')
    view.layoutStyle = doc.createElement('style')
    head.append(view.userStyle, view.layoutStyle)
    view.userStyle.textContent = this.#styles
    view.layoutStyle.textContent = this.#layoutCSS()

    // Measure the text once its typeface is in: laid out in the fallback
    // first, everything below would move when the real one arrives. (Fonts
    // only start loading when a layout asks for them.)
    void doc.body?.offsetHeight
    await Promise.race([doc.fonts?.ready, new Promise(resolve => setTimeout(resolve, 400))])
    if (view.dead) return

    this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
    // Whoever is waiting for this view may have moved on; compensate here.
    if (this.#expand(view)) this.#restoreAnchor()
    view.observer = new ResizeObserver(() => {
      if (this.#expand(view)) this.#restoreAnchor()
    })
    view.observer.observe(doc.documentElement)
    if (doc.body) view.observer.observe(doc.body)
    void doc.fonts?.ready.then(() => {
      if (!view.dead && this.#expand(view)) this.#restoreAnchor()
    })
    this.dispatchEvent(
      new CustomEvent('create-overlayer', {
        detail: {
          doc,
          index,
          attach: (overlayer: OverlayerLike) => {
            view.overlayer = overlayer
            view.element.append(overlayer.element)
          },
        },
      }),
    )
  }

  /** Sizes a view's iframe to its content. Returns whether the height changed. */
  #expand(view: View): boolean {
    const root = view.doc?.documentElement
    if (!root || view.dead) return false
    const height = Math.ceil(root.getBoundingClientRect().height)
    if (!height || height === view.height) return false
    // Content sized relative to the frame (vh units) could grow forever:
    // give up on a view that keeps changing height within one burst.
    const now = performance.now()
    if (now - view.resizeBurst > 1000) {
      view.resizeBurst = now
      view.resizes = 0
    }
    if (++view.resizes > 60) return false
    view.height = height
    view.iframe.style.height = `${height}px`
    view.overlayer?.redraw()
    return true
  }

  #removeView(view: View): void {
    view.dead = true
    view.cancel?.()
    view.observer?.disconnect()
    view.element.remove()
    this.#sections[view.index]?.unload?.()
    const at = this.#views.indexOf(view)
    if (at >= 0) this.#views.splice(at, 1)
  }

  #clear(): void {
    for (const view of [...this.#views]) this.#removeView(view)
    this.#anchor = null
  }

  /* ---------- filling and trimming around the viewport ---------- */

  #scheduleFill(): void {
    if (this.#fillQueued) return
    this.#fillQueued = true
    requestAnimationFrame(() => {
      this.#fillQueued = false
      void this.#fill()
    })
  }

  async #fill(): Promise<void> {
    if (this.#filling || this.#destroyed) return
    this.#filling = true
    const generation = this.#generation
    try {
      for (let guard = 0; guard < 50; guard++) {
        if (generation !== this.#generation || !this.#views.length) return
        const { scrollTop, clientHeight, scrollHeight } = this.#container
        const first = this.#views[0]
        const last = this.#views.at(-1)!
        const below = scrollHeight - (scrollTop + clientHeight)
        const next = this.#adjacent(last.index, 1)
        const previous = this.#adjacent(first.index, -1)
        let view: View | null = null
        if (next != null && below < clientHeight * AHEAD) view = this.#createView(next, 'append')
        else if (previous != null && scrollTop < clientHeight * AHEAD) {
          view = this.#createView(previous, 'prepend')
          // The placeholder pushed everything down; put it back before paint.
          this.#restoreAnchor()
        }
        if (!view) break
        await view.ready
        this.#restoreAnchor()
        if (generation !== this.#generation) return
      }
      this.#trim()
    } finally {
      this.#filling = false
      // A navigation interrupted us; fill around the new position instead.
      if (generation !== this.#generation && !this.#destroyed) this.#scheduleFill()
    }
  }

  #trim(): void {
    const limit = this.#container.clientHeight * KEEP
    // Each removal shifts the layout; put the position right before judging
    // the next view, or one trim cascades into several.
    while (this.#views.length > 3) {
      const first = this.#views[0]
      if (first === this.#anchor?.view) break
      if (this.#top(first) + first.element.offsetHeight > this.#container.scrollTop - limit) break
      this.#removeView(first)
      this.#restoreAnchor()
    }
    while (this.#views.length > 3) {
      const last = this.#views.at(-1)!
      if (last === this.#anchor?.view) break
      const { scrollTop, clientHeight } = this.#container
      if (this.#top(last) < scrollTop + clientHeight + limit) break
      this.#removeView(last)
    }
  }

  /* ---------- events ---------- */

  #onScroll(): void {
    // A scroll we caused by restoring the anchor is not the reader moving:
    // keep the anchor. (Taking a new one now could even be wrong, while a
    // restyled section has not been measured again yet.)
    const own = Math.abs(this.#container.scrollTop - this.#restoredTo) < 1
    this.#restoredTo = -1
    if (!own) this.#captureAnchor()
    this.#scheduleFill()
    this.dispatchEvent(new Event('scroll'))
    clearTimeout(this.#relocateTimer)
    this.#relocateTimer = setTimeout(() => this.#relocate('scroll'), 150)
  }

  #onResize(): void {
    const width = this.#container.clientWidth
    if (width === this.#width) {
      // Only the height changed: nothing reflows, but more may fit now.
      this.#scheduleFill()
      return
    }
    this.#width = width
    this.#relayout()
  }

  #relayout(): void {
    this.style.setProperty('--_pad', `${this.#pad}px`)
    const css = this.#layoutCSS()
    for (const view of this.#views) {
      if (view.layoutStyle) view.layoutStyle.textContent = css
      this.#expand(view)
    }
    this.#restoreAnchor()
    this.#scheduleFill()
  }

  #visibleRange(view: View): Range | null {
    const doc = view.doc
    if (!doc?.body) return null
    const { scrollTop, clientHeight } = this.#container
    const pad = this.#pad
    const width = doc.documentElement.clientWidth
    const edge = scrollTop - this.#top(view)
    const top = Math.max(0, edge)
    const bottom = Math.min(view.height - 1, top + clientHeight)
    const caret = (x: number, y: number): Range | null => {
      try {
        return doc.caretRangeFromPoint(x, y)
      } catch {
        return null
      }
    }
    const end = caret(width - pad - 2, bottom - 4) ?? caret(width / 2, bottom - 4)
    /** What is in view from a caret on. */
    const from = (start: Range | null): Range => {
      const range = doc.createRange()
      try {
        if (start) range.setStart(start.startContainer, start.startOffset)
        else range.setStart(doc.body, 0)
        if (end && range.comparePoint(end.startContainer, end.startOffset) >= 0)
          range.setEnd(end.startContainer, end.startOffset)
        else range.collapse(true)
      } catch {
        range.selectNodeContents(doc.body)
        range.collapse(true)
      }
      return range
    }
    // The range starts with the line that `goTo` would put below its margin:
    // coming back to it then leaves the view where it is, rather than a
    // line further up each time. That is the line the reading line runs
    // through. Where it falls between two, it is the one above if that is
    // in view as a whole (nothing in view is then pushed out of it), and
    // otherwise the one below.
    const line = Math.min(view.height - 1, Math.max(0, edge + TOP_MARGIN) + READING_LINE)
    let range: Range | null = null
    for (let y = line; y > top && !range; y -= 8) {
      const candidate = from(caret(pad + 2, y))
      const box = this.#boxOf(candidate)
      if (box && box.top <= line && (box.bottom > line || box.top >= top)) range = candidate
    }
    for (let y = line + 8; y <= line + 48 && !range; y += 8) {
      const candidate = from(caret(pad + 2, y))
      const box = this.#boxOf(candidate)
      if (box && box.top > line) range = candidate
    }
    range ??= from(caret(pad + 2, line) ?? caret(width / 2, line))
    // Where that line runs through a picture or a formula, this is the top
    // of that, and coming back shows it from there. With the top far above
    // the view that is a long way from where the reader was: text a little
    // further down may well be closer.
    const off = (shown: Range, y: number) => Math.abs(this.#offsetOf(view, shown) - y)
    if (off(range, line) > clientHeight / 3)
      for (let y = line + 24; y < Math.min(view.height, top + clientHeight / 2); y += 24) {
        const below = caret(pad + 2, y)
        if (below?.startContainer.nodeType !== 3) continue
        const candidate = from(below)
        if (off(candidate, y) > 32) continue
        if (y - line < off(range, line)) range = candidate
        break
      }
    return range
  }

  /** Whether the end of the book is in view. */
  #atEnd(): boolean {
    const last = this.#views.at(-1)
    if (!last?.doc || this.#adjacent(last.index, 1) != null) return false
    const { scrollTop, clientHeight } = this.#container
    return this.#top(last) + last.element.offsetHeight <= scrollTop + clientHeight + 1
  }

  #relocate(reason: string): void {
    clearTimeout(this.#relocateTimer)
    this.#relocateTimer = undefined
    if (this.#destroyed) return
    // (the view the reading line is in: the last few pixels of the section
    // before it may still show above)
    const view = this.#current(TOP_MARGIN + READING_LINE)
    if (!view?.doc) return
    const { scrollTop } = this.#container
    const fraction = Math.min(1, Math.max(0, (scrollTop - this.#top(view)) / Math.max(1, view.height)))
    this.dispatchEvent(
      new CustomEvent('relocate', {
        detail: {
          reason,
          range: this.#visibleRange(view),
          index: view.index,
          fraction,
          atEnd: this.#atEnd(),
        },
      }),
    )
  }

  /** Reports the position now if scrolling has moved it and the report is still to come. */
  flush(): void {
    if (this.#relocateTimer !== undefined) this.#relocate('scroll')
  }

  /* ---------- the renderer interface ---------- */

  /** The box of the first line (or picture) of a range or an element. */
  #boxOf(subject: Range | Element): DOMRect | undefined {
    const rects = subject.getClientRects()
    return Array.from(rects).find(r => r.width > 0 || r.height > 0) ?? rects[0]
  }

  #offsetOf(view: View, target: Target): number {
    if (typeof target === 'number') return target * view.height
    const subject = isRange(target) || isElement(target) ? target : null
    if (!subject) return 0
    const rect = this.#boxOf(subject)
    if (rect) return rect.top
    // A collapsed range may have no rects; fall back on its container.
    const node = isRange(subject) ? subject.startContainer : subject
    const element = node.nodeType === 1 ? (node as Element) : node.parentElement
    return element?.getBoundingClientRect().top ?? 0
  }

  async goTo(target: { index: number; anchor?: Anchor | number; select?: boolean }): Promise<void> {
    const resolved = await target
    const { index } = resolved
    // (also catches the undefined/NaN index of a link that leads nowhere)
    if (this.#destroyed || !(index >= 0 && index < this.#sections.length)) return
    const generation = ++this.#generation
    let view = this.#views.find(v => v.index === index)
    if (!view) {
      this.#clear()
      this.#container.scrollTop = 0
      view = this.#createView(index, 'append')
    }
    await view.ready
    if (generation !== this.#generation || view.dead) return
    this.#show(view, resolved.anchor)
    this.#relocate('navigation')
    await this.#fill()
    if (generation !== this.#generation) return
    this.#restoreAnchor()
  }

  /** Scrolls to what an anchor points at in a (loaded) view. */
  #show(view: View, anchor: Anchor | number | undefined): void {
    this.#expand(view)
    let where: Target = 0
    if (typeof anchor === 'function') {
      try {
        where = view.doc ? anchor(view.doc) : 0
      } catch {
        where = 0
      }
    } else if (typeof anchor === 'number') where = anchor
    const fraction = typeof where === 'number'
    const offset = this.#offsetOf(view, where)
    this.#container.scrollTop = Math.max(0, this.#top(view) + offset - (fraction ? 0 : TOP_MARGIN))
    // (our own scroll: #onScroll must not take it for the reader moving on)
    this.#restoredTo = this.#container.scrollTop
    this.#captureAnchor()
    if (this.#anchor && typeof anchor === 'function') this.#anchor.again = () => this.#show(view, anchor)
  }

  /** Brings a range or element into the comfortable part of the viewport. */
  async scrollToAnchor(anchor: Range | Element): Promise<void> {
    const doc = isRange(anchor) ? anchor.startContainer.ownerDocument : anchor.ownerDocument
    const view = this.#views.find(v => v.doc === doc)
    if (!view) return
    const { scrollTop, clientHeight } = this.#container
    const y = this.#top(view) + this.#offsetOf(view, anchor)
    if (y >= scrollTop + clientHeight * 0.08 && y <= scrollTop + clientHeight * 0.7) return
    this.#container.scrollTo({ top: Math.max(0, y - clientHeight * 0.2), behavior: 'smooth' })
  }

  #page(direction: 1 | -1, distance?: number): Promise<void> {
    const step = distance ?? Math.max(80, this.#container.clientHeight - 56)
    this.#container.scrollBy({ top: direction * step, behavior: distance ? 'auto' : 'smooth' })
    return Promise.resolve()
  }

  next(distance?: number): Promise<void> {
    return this.#page(1, distance)
  }

  prev(distance?: number): Promise<void> {
    return this.#page(-1, distance)
  }

  getContents(): { doc: Document; index: number; overlayer: OverlayerLike | null }[] {
    const current = this.#current()
    const loaded = this.#views.filter(view => view.doc && !view.dead)
    // The view being read comes first, as callers treat [0] as "the" content.
    loaded.sort((a, b) => Number(b === current) - Number(a === current))
    return loaded.map(view => ({ doc: view.doc!, index: view.index, overlayer: view.overlayer }))
  }

  setStyles(styles: string): void {
    this.#styles = styles
    for (const view of this.#views) {
      if (view.userStyle) view.userStyle.textContent = styles
      this.#expand(view)
    }
    this.#restoreAnchor()
  }

  focusView(): void {
    this.#container.focus({ preventScroll: true })
  }

  destroy(): void {
    this.#destroyed = true
    this.#generation++
    clearTimeout(this.#relocateTimer)
    this.#resizeObserver.disconnect()
    this.#clear()
  }
}

if (!customElements.get('bv-scroller')) customElements.define('bv-scroller', Scroller)
