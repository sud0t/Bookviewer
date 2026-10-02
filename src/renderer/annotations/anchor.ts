/**
 * Text anchoring: describing a DOM range by the text it covers (a W3C-style
 * text-quote selector plus character offsets), and finding that text again
 * later, possibly in a document whose markup has changed.
 */
import type { TextPosition, TextQuote } from '@shared/types'

const CONTEXT = 32

/** A document's text nodes laid end to end. */
export interface TextMap {
  text: string
  nodes: Text[]
  /** `starts[i]` is where `nodes[i]` begins in `text`. */
  starts: number[]
}

const SKIPPED = new Set(['script', 'style', 'noscript', 'template'])
/** Elements the reader itself added to a page (rendered math, ...). */
const INJECTED = 'data-bv-ignore'

export function textMap(root: Node): TextMap {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, 0x1 | 0x4 /* elements and text */, {
    acceptNode: node =>
      node.nodeType === 1
        ? SKIPPED.has((node as Element).localName) || (node as Element).hasAttribute(INJECTED)
          ? 2 /* reject */
          : 3 /* skip */
        : 1 /* accept */,
  })
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text)
    starts.push(text.length)
    text += node.nodeValue ?? ''
  }
  return { text, nodes, starts }
}

/** Index of the last text node starting at or before `offset`. */
function nodeAt(map: TextMap, offset: number): number {
  let low = 0
  let high = map.starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (map.starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low
}

export function offsetsToRange(map: TextMap, start: number, end: number): Range | null {
  if (!map.nodes.length || start < 0 || end > map.text.length || start > end) return null
  const doc = map.nodes[0].ownerDocument
  const range = doc.createRange()
  let first = nodeAt(map, start)
  // A boundary that falls exactly between two nodes belongs to the later
  // one at the start of a range and the earlier one at the end.
  while (
    start < end &&
    first < map.nodes.length - 1 &&
    start >= map.starts[first] + map.nodes[first].length
  )
    first++
  let last = nodeAt(map, end)
  while (last > first && end === map.starts[last]) last--
  range.setStart(map.nodes[first], Math.min(start - map.starts[first], map.nodes[first].length))
  range.setEnd(map.nodes[last], Math.min(end - map.starts[last], map.nodes[last].length))
  return range
}

/** Converts one boundary point of a range to an offset into the text map. */
function pointToOffset(map: TextMap, container: Node, offset: number): number | null {
  if (container.nodeType === 3) {
    const index = map.nodes.indexOf(container as Text)
    return index < 0 ? null : map.starts[index] + offset
  }
  // An element boundary: the offset of the first text node at or after it.
  const doc = container.ownerDocument!
  const point = doc.createRange()
  point.setStart(container, offset)
  point.collapse(true)
  let low = 0
  let high = map.nodes.length
  while (low < high) {
    const mid = (low + high) >> 1
    const node = map.nodes[mid]
    // Is the boundary point before this text node?
    if (point.comparePoint(node, 0) >= 0) high = mid
    else low = mid + 1
  }
  return low < map.nodes.length ? map.starts[low] : map.text.length
}

export function rangeToOffsets(map: TextMap, range: Range): TextPosition | null {
  const start = pointToOffset(map, range.startContainer, range.startOffset)
  const end = pointToOffset(map, range.endContainer, range.endOffset)
  if (start == null || end == null || end < start) return null
  return { start, end }
}

export interface RangeDescription {
  quote: TextQuote
  position: TextPosition
}

export function describeRange(root: Node, range: Range, map = textMap(root)): RangeDescription | null {
  const position = rangeToOffsets(map, range)
  if (!position) return null
  const { start, end } = position
  return {
    position,
    quote: {
      exact: map.text.slice(start, end),
      prefix: map.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: map.text.slice(end, end + CONTEXT),
    },
  }
}

/** Collapses whitespace runs, keeping a map back to the original offsets. */
function normalize(text: string): { text: string; map: number[] } {
  let out = ''
  const map: number[] = []
  let inSpace = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const space = /\s/.test(char)
    if (space) {
      if (!inSpace && out.length) {
        out += ' '
        map.push(i)
      }
      inSpace = true
    } else {
      out += char
      map.push(i)
      inSpace = false
    }
  }
  map.push(text.length)
  return { text: out, map }
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()
/** Like `squash`, but a space at either end is kept: it is part of the context. */
const collapse = (text: string): string => text.replace(/\s+/g, ' ')

function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/**
 * Finds a quote in the text. Among several occurrences the one whose
 * surroundings best match the recorded prefix/suffix wins, with the old
 * position breaking ties.
 */
export function findQuote(text: string, quote: TextQuote, hint?: number): TextPosition | null {
  const pick = (
    haystack: string,
    exact: string,
    prefix: string,
    suffix: string,
    at: number | undefined,
  ): number => {
    if (!exact) return -1
    let best = -1
    let bestScore = -Infinity
    for (let i = haystack.indexOf(exact); i >= 0; i = haystack.indexOf(exact, i + 1)) {
      let score =
        commonSuffix(haystack.slice(Math.max(0, i - prefix.length), i), prefix) +
        commonPrefix(haystack.slice(i + exact.length, i + exact.length + suffix.length), suffix)
      if (at != null) score -= Math.min(1, Math.abs(i - at) / Math.max(1, haystack.length)) * 0.5
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    return best
  }

  const direct = pick(text, quote.exact, quote.prefix, quote.suffix, hint)
  if (direct >= 0) return { start: direct, end: direct + quote.exact.length }

  // The markup may have been re-wrapped or re-indented: compare with
  // whitespace collapsed on both sides.
  const normalized = normalize(text)
  const exact = squash(quote.exact)
  const found = pick(
    normalized.text,
    exact,
    collapse(quote.prefix),
    collapse(quote.suffix),
    hint == null ? undefined : normalized.map.findIndex(original => original >= hint),
  )
  if (found < 0) return null
  return {
    start: normalized.map[found],
    end: normalized.map[found + exact.length - 1] + 1,
  }
}

export function anchorQuote(
  root: Node,
  quote: TextQuote,
  hint?: number,
  map = textMap(root),
): Range | null {
  const position = findQuote(map.text, quote, hint)
  return position ? offsetsToRange(map, position.start, position.end) : null
}

/** Whether a range still covers the text it was created on. */
export function rangeMatches(range: Range, quote: TextQuote): boolean {
  return squash(range.toString()) === squash(quote.exact)
}
