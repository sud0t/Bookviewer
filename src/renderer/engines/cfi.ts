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

/**
 * A point inside something we inserted (a rendered formula) has no address
 * in the original document. The end of the original text just before it -
 * for a formula, its source - stands in for it.
 */
function original(node: Node, offset: number): [Node, number] {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  const inserted = element?.closest(`[${IGNORE}]`)
  const body = inserted?.ownerDocument.body
  if (!inserted || !body) return [node, offset]
  const walker = body.ownerDocument.createTreeWalker(body, 0x4, {
    acceptNode: text => (text.parentElement?.closest(`[${IGNORE}]`) ? REJECT : ACCEPT),
  })
  walker.currentNode = inserted
  const before = walker.previousNode() as Text | null
  if (before) return [before, before.length]
  walker.currentNode = inserted
  const after = walker.nextNode()
  return after ? [after, 0] : [node, offset]
}

export function fromRange(range: Range): string {
  const clean = range.cloneRange()
  clean.setStart(...original(range.startContainer, range.startOffset))
  clean.setEnd(...original(range.endContainer, range.endOffset))
  return CFI.fromRange(clean, cfiFilter)
}

/** A CFI whose end can no longer be found in the document still says where it starts. */
export function toRange(doc: Document, parts: CFI.ParsedCFI): Range {
  try {
    return CFI.toRange(doc, parts, cfiFilter)
  } catch (error) {
    if (!('parent' in parts)) throw error
    return CFI.toRange(doc, CFI.collapse(parts) as CFI.ParsedCFI, cfiFilter)
  }
}

export { CFI }
