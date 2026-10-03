const WORD_CHAR = /[\p{L}\p{N}\p{M}'’_-]/u

/**
 * What a right-click in book text acts on: the selection, when the click
 * landed on it; otherwise the word under the pointer, which becomes the
 * selection. False when there is neither.
 */
export function selectForContextMenu(doc: Document, event: MouseEvent): boolean {
  const selection = doc.getSelection()
  if (!selection) return false
  const { clientX: x, clientY: y } = event
  if (!selection.isCollapsed && selection.rangeCount) {
    const onIt = [...selection.getRangeAt(0).getClientRects()].some(
      rect => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2,
    )
    if (onIt) return true
  }
  const caret = doc.caretPositionFromPoint?.(x, y)
  const node = caret?.offsetNode
  if (!caret || node?.nodeType !== 3) return false
  const text = (node as Text).data
  let start = caret.offset
  let end = caret.offset
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--
  while (end < text.length && WORD_CHAR.test(text[end])) end++
  if (start === end) return false
  const range = doc.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}
