import type { Annotation, Selector, Settings, ThemeName } from '@shared/types'

export interface TocItem {
  id: string
  label: string
  /** What to pass to `Engine.goTo`; null for headings that lead nowhere. */
  target: string | null
  children: TocItem[]
}

/** A rectangle in the app window's viewport coordinates. */
export interface ViewportRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Relocation {
  /** Progress through the whole book, 0..1. */
  fraction: number
  /** Opaque string that `Engine.goTo` accepts to come back here. */
  location: string
  tocId: string | null
  /** Title of the current chapter / section. */
  label: string
  /** "Page 12 of 340", "Loc 80 of 2100" - whatever the format counts in. */
  page: { current: number; total: number; unit: 'page' | 'loc' } | null
  /** Text at the top of the view, for bookmark excerpts. */
  excerpt: string
  /** Estimated reading time left, where the format allows a guess. */
  minutesLeft?: { chapter: number; book: number }
}

export interface SelectionInfo {
  text: string
  selector: Selector
  label: string
  position: number
  rect: ViewportRect
  language: string
  /**
   * When the selection cannot be kept as one highlight (in a PDF, it runs
   * over a page break): the pieces to highlight instead, in reading order.
   */
  parts?: Pick<SelectionInfo, 'text' | 'selector' | 'label' | 'position'>[]
}

export interface SearchHit {
  /** Pass to `Engine.goTo`. */
  target: string
  pre: string
  match: string
  post: string
}

export interface SearchGroup {
  label: string
  hits: SearchHit[]
}

export type SearchUpdate = { progress: number } | { group: SearchGroup }

export interface SearchOptions {
  matchCase: boolean
  wholeWords: boolean
}

/** A stretch of text to speak, and how to show where it is. */
export interface SpeechSegment {
  text: string
  language: string
  /** Scrolls to the segment and marks it as being read. */
  show(): void
}

export interface Appearance {
  settings: Settings
  theme: ThemeName
}

export interface EngineEvents {
  relocate(relocation: Relocation): void
  /** The user selected text, or (null) the selection went away. */
  selection(selection: SelectionInfo | null): void
  annotationClick(id: number, rect: ViewportRect): void
  /** A key was pressed while focus was inside book content. */
  keydown(event: KeyboardEvent): void
  /** A plain click on the page (not on a link or a highlight). */
  click(): void
  /** An internal link is about to be followed (a chance to remember where we were). */
  jump(): void
  /** The user changed a setting from inside the book view (zooming with the wheel, ...). */
  settings(patch: Partial<Settings>): void
}

export interface Engine {
  readonly toc: TocItem[]
  /** Whether the flow / typography settings mean anything for this book. */
  readonly reflowable: boolean
  readonly language: string
  /** Where each chapter starts, as fractions of the whole book (once open). */
  readonly chapterStarts: number[]

  open(
    container: HTMLElement,
    init: { location: string | null; appearance: Appearance; annotations: Annotation[] },
  ): Promise<void>
  destroy(): void

  goTo(target: string): Promise<void>
  goToFraction(fraction: number): Promise<void>
  /** What is at a position in the book (0..1), for previewing a jump along the progress bar. */
  describe(fraction: number): { label: string; page: Relocation['page'] }
  /**
   * For books whose pages have a fixed size: zooms one step in (1) or out
   * (-1), or back to fitting the width (0), and reports the new setting
   * through `EngineEvents.settings`.
   */
  zoom?(direction: 1 | -1 | 0): void
  /**
   * Whether a stored location (a bookmark's) is in the part of the book that
   * is on screen now. Only meaningful right after a `relocate`.
   */
  isInView(location: string): boolean
  next(): void
  prev(): void
  /** A small move: a few lines when scrolling, a page when paginated. */
  step(direction: 1 | -1): void
  /** Start / end of the book. */
  goToEdge(edge: 'start' | 'end'): void
  /**
   * Reports the current position (`relocate`) now if a move has not been
   * reported yet - scrolling is only reported once it pauses.
   */
  flush(): void
  /**
   * Resolves when the moves under way are over and reported: a jump whose
   * section is still loading, a page turn that is being animated.
   */
  settled(): Promise<void>

  setAppearance(appearance: Appearance): void

  /** Replaces the set of annotations to draw. */
  setAnnotations(annotations: Annotation[]): void
  /** Navigates to an annotation and reports it as if it had been clicked. */
  showAnnotation(annotation: Annotation): Promise<void>
  clearSelection(): void

  search(query: string, options: SearchOptions): AsyncGenerator<SearchUpdate>
  clearSearch(): void
  /** Draws one search result (a hit's `target`) as the current one; null for none. */
  markSearchHit?(target: string | null): void

  /**
   * Yields the text from the current position (or selection) onwards, one
   * batch per section / page. Asking for the next batch may turn the page,
   * so callers should finish speaking a batch before pulling another.
   */
  speech(): AsyncGenerator<SpeechSegment[]>
  clearSpeechMark(): void

  focus(): void
}

export const HIGHLIGHT_HEX: Record<string, string> = {
  yellow: '#f7d34a',
  green: '#6fcf5f',
  blue: '#5aa9f0',
  pink: '#f27aa9',
  purple: '#a983f0',
}
