/**
 * EPUB CFIs, computed so that nodes we add to a document (rendered math and
 * the like) do not disturb them: a CFI made on the page as displayed means
 * the same thing on the pristine document, and the other way round.
 */
import * as CFI from 'foliate-js/epubcfi.js'

/** Marks an element we inserted; it is invisible to CFIs and text anchoring. */
export const IGNORE = 'data-bv-ignore'
/** Marks a wrapper we put around original content; only the wrapper itself is ignored. */
export const SKIP = 'data-bv-skip'

const ACCEPT = 1
const REJECT = 2
const SKIP_NODE = 3

export function cfiFilter(node: Node): number {
  if (node.nodeType !== 1) return ACCEPT
  const element = node as Element
  if (element.hasAttribute(IGNORE)) return REJECT
  if (element.hasAttribute(SKIP)) return SKIP_NODE
  return ACCEPT
}

export const fromRange = (range: Range): string => CFI.fromRange(range, cfiFilter)

export const toRange = (doc: Document, parts: CFI.ParsedCFI): Range =>
  CFI.toRange(doc, parts, cfiFilter)

export { CFI }
