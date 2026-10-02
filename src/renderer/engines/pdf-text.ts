/** Reading text out of a pdf.js text layer the way a person reads the page. */
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
