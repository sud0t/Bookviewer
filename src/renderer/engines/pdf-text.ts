/**
 * The parts of the PDF engine that need no viewer (and so can be tested on
 * their own): reading text out of a pdf.js text layer the way a person reads
 * the page, and the arithmetic of pages and zoom.
 */
import { offsetsToRange, textMap } from '../annotations/anchor'

/** A word broken across lines: "exam-" + "ple". */
export const HYPHENATED = /[A-Za-z\u00C0-\u024F]-$/

/**
 * The text a range covers in a pdf.js text layer, read the way a person
 * would: line ends (which are <br>s there, with no space) separate words,
 * unless the line ended in a hyphenated word.
 */
export function layerText(layer: Element, range?: Range): string {
  const doc = layer.ownerDocument
  const walker = doc.createTreeWalker(layer, 0x1 | 0x4)
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (range && !range.intersectsNode(node)) continue
    if (node.nodeType === 1) {
      if ((node as Element).localName !== 'br' || !text) continue
      if (HYPHENATED.test(text)) text = text.slice(0, -1)
      else if (!text.endsWith(' ')) text += ' '
      continue
    }
    let value = node.nodeValue ?? ''
    if (range) {
      const end = node === range.endContainer ? range.endOffset : value.length
      const start = node === range.startContainer ? range.startOffset : 0
      value = value.slice(start, end)
    }
    text += value
  }
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Finds a sentence (as produced from the page's text content) in the text
 * layer. The two differ in spacing and in hyphens at line ends, so they are
 * compared with both taken out.
 */
export function findInLayer(layer: Element, sentence: string): Range | null {
  const map = textMap(layer)
  let squeezed = ''
  const origin: number[] = []
  for (const [index, node] of map.nodes.entries()) {
    const value = node.data
    // a hyphen that only exists because the line ended there
    const next = node.parentElement?.nextSibling
    const broken =
      HYPHENATED.test(value) && value.length > 1 && next?.nodeType === 1 && (next as Element).localName === 'br'
    const length = broken ? value.length - 1 : value.length
    for (let i = 0; i < length; i++) {
      if (/\s/.test(value[i])) continue
      squeezed += value[i]
      origin.push(map.starts[index] + i)
    }
  }
  const needle = sentence.replace(/\s+/g, '')
  if (!needle) return null
  const at = squeezed.indexOf(needle)
  if (at < 0) return null
  return offsetsToRange(map, origin[at], origin[at + needle.length - 1] + 1)
}

/* ---------- pages and zoom ---------- */

export interface PageSize {
  width: number
  height: number
}

/**
 * The page size a "fit" zoom should go by: the largest of the book's usual
 * pages. Not the page in view (a cover smaller than the rest would leave
 * every other page cut off), and not the very largest (one fold-out would
 * shrink the whole book).
 */
export function usualPageSize(sizes: PageSize[]): PageSize {
  const usual = (values: number[]): number => {
    const sorted = values.filter(value => value > 0).sort((a, b) => a - b)
    if (!sorted.length) return 0
    const median = sorted[Math.floor(sorted.length / 2)]
    // pages a little larger than most (uneven scans) still have to fit
    return sorted.findLast(value => value <= median * 1.1) ?? median
  }
  return { width: usual(sizes.map(size => size.width)), height: usual(sizes.map(size => size.height)) }
}

/** The room pdf.js leaves beside and above a page when it fits one to the window. */
const FIT_MARGIN = { x: 40, y: 5 }
const MAX_AUTO_ZOOM = 1.25

export type FitMode = 'page-width' | 'page-fit' | 'auto'

/** The scale at which a page of `page` size (at scale 1) fits a window of `room` size. */
export function fitScale(mode: FitMode, page: PageSize, room: PageSize): number {
  const byWidth = (room.width - FIT_MARGIN.x) / page.width
  const byHeight = (room.height - FIT_MARGIN.y) / page.height
  if (mode === 'page-width') return byWidth
  if (mode === 'page-fit') return Math.min(byWidth, byHeight)
  // as wide as the window for upright pages, but never blown up far past life size
  return Math.min(MAX_AUTO_ZOOM, page.width <= page.height ? byWidth : Math.min(byWidth, byHeight))
}

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 6
const ZOOM_STEP = 1.1

/** The scale one zoom step in (1) or out (-1) from `scale`. */
export function zoomStep(scale: number, direction: 1 | -1): number {
  const next = direction > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) * 100) / 100
}

/** The page a position in the book (0..1) falls on, and how far down that page (0..1). */
export function pageAtFraction(fraction: number, pages: number): { page: number; within: number } {
  const exact = Math.min(0.9999, Math.max(0, fraction || 0)) * Math.max(1, pages)
  const index = Math.floor(exact)
  return { page: index + 1, within: exact - index }
}
