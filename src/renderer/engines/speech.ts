/** Splits a rendered document into sentences to read aloud, in order. */
import { offsetsToRange, type TextMap } from '../annotations/anchor'

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'pre', 'math', 'svg', 'rt', 'rp'])
const INLINE = /^(inline|inline-block|inline-flex|ruby|contents)/

export interface SpokenSegment {
  text: string
  range: Range
}

/**
 * Yields the sentences of `doc`, each with the DOM range it covers. With
 * `from`, starts at the first sentence that ends after that range begins.
 */
export function* speechSegments(
  doc: Document,
  language: string,
  from: Range | null,
): Generator<SpokenSegment> {
  const view = doc.defaultView
  if (!view || !doc.body) return

  const blockOf = new Map<Element, Element>()
  const block = (element: Element): Element => {
    const known = blockOf.get(element)
    if (known) return known
    let found: Element = element
    for (let el: Element | null = element; el; el = el.parentElement) {
      found = el
      if (el === doc.body || !INLINE.test(view.getComputedStyle(el).display)) break
    }
    blockOf.set(element, found)
    return found
  }

  const walker = doc.createTreeWalker(doc.body, 0x1 | 0x4, {
    acceptNode(node) {
      if (node.nodeType !== 1) return 1
      const element = node as HTMLElement
      if (SKIP.has(element.localName)) return 2
      if (element.getAttribute('aria-hidden') === 'true' || element.classList.contains('headerlink'))
        return 2
      // rendered formulas and their hidden TeX source
      if (element.hasAttribute('data-bv-ignore') || element.hasAttribute('data-bv-skip')) return 2
      return 3
    },
  })

  // Group consecutive text nodes by the block they belong to.
  const groups: Text[][] = []
  let currentBlock: Element | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent) continue
    const owner = block(parent)
    if (owner !== currentBlock || !groups.length) {
      groups.push([])
      currentBlock = owner
    }
    groups.at(-1)!.push(node as Text)
  }

  let segmenter: Intl.Segmenter
  try {
    segmenter = new Intl.Segmenter(language || undefined, { granularity: 'sentence' })
  } catch {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' })
  }

  let started = !from
  for (const nodes of groups) {
    const map: TextMap = { text: '', nodes, starts: [] }
    for (const node of nodes) {
      map.starts.push(map.text.length)
      map.text += node.nodeValue ?? ''
    }
    if (!map.text.trim()) continue
    // Nothing renders for text inside a hidden element.
    const parent = nodes[0].parentElement as HTMLElement | null
    if (parent && parent !== doc.body && parent.offsetParent === null) {
      const { position, display } = view.getComputedStyle(parent)
      if (position !== 'fixed' || display === 'none') continue
    }
    // A line break in the markup is a sentence boundary to the segmenter;
    // hard-wrapped source would be read out in fragments. (Same length, so
    // offsets still line up.)
    const flowed = map.text.replace(/[\n\r\u0085\u2028\u2029]/g, ' ')
    for (const { segment, index } of segmenter.segment(flowed)) {
      const text = segment.replace(/\s+/g, ' ').trim()
      if (!/[\p{L}\p{N}]/u.test(text)) continue
      const lead = segment.length - segment.trimStart().length
      const range = offsetsToRange(map, index + lead, index + segment.trimEnd().length)
      if (!range) continue
      if (!started) {
        // Skip sentences that end before the starting point.
        if (from!.comparePoint(range.endContainer, range.endOffset) < 0) continue
        started = true
      }
      yield { text, range }
    }
  }
}
