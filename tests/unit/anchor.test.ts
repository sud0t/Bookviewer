// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  anchorQuote,
  describeRange,
  findQuote,
  offsetsToRange,
  rangeMatches,
  rangeToOffsets,
  textMap,
} from '../../src/renderer/annotations/anchor'
import { CFI, IGNORE, SKIP, fromRange, toRange } from '../../src/renderer/engines/cfi'

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')

const PAGE = `<html><body>
  <h1>Chapter One</h1>
  <p>The quick brown fox jumps over the lazy dog.</p>
  <p>A <em>second</em> paragraph, with <code>inline code</code> and the quick brown fox again.</p>
  <script>ignored()</script>
</body></html>`

/** The range covering `text`'s nth occurrence in the document. */
function rangeOf(doc: Document, text: string, occurrence = 0): Range {
  const map = textMap(doc.body)
  let at = -1
  for (let i = 0; i <= occurrence; i++) at = map.text.indexOf(text, at + 1)
  expect(at).toBeGreaterThanOrEqual(0)
  return offsetsToRange(map, at, at + text.length)!
}

describe('text map', () => {
  it('skips script and style content', () => {
    expect(textMap(parse(PAGE).body).text).not.toContain('ignored')
  })

  it('converts between ranges and offsets', () => {
    const doc = parse(PAGE)
    const map = textMap(doc.body)
    const range = rangeOf(doc, 'second paragraph')
    expect(range.toString()).toBe('second paragraph')
    const offsets = rangeToOffsets(map, range)!
    expect(map.text.slice(offsets.start, offsets.end)).toBe('second paragraph')
  })

  it('handles ranges whose boundaries are element positions', () => {
    const doc = parse(PAGE)
    const range = doc.createRange()
    range.selectNodeContents(doc.querySelector('em')!)
    const described = describeRange(doc.body, range)!
    expect(described.quote.exact).toBe('second')
  })
})

describe('text-quote anchoring', () => {
  it('round-trips a selection', () => {
    const doc = parse(PAGE)
    const range = rangeOf(doc, 'jumps over the lazy')
    const { quote, position } = describeRange(doc.body, range)!
    expect(quote.exact).toBe('jumps over the lazy')
    expect(quote.prefix.endsWith('brown fox ')).toBe(true)
    const again = anchorQuote(doc.body, quote, position.start)!
    expect(again.toString()).toBe('jumps over the lazy')
    expect(rangeMatches(again, quote)).toBe(true)
  })

  it('uses the context to tell repeated text apart', () => {
    const doc = parse(PAGE)
    const second = rangeOf(doc, 'quick brown fox', 1)
    const { quote } = describeRange(doc.body, second)!
    const found = findQuote(textMap(doc.body).text, quote)!
    expect(found.start).toBe(rangeToOffsets(textMap(doc.body), second)!.start)
  })

  it('survives the markup being rewritten around the same words', () => {
    const doc = parse(PAGE)
    const { quote, position } = describeRange(doc.body, rangeOf(doc, 'paragraph, with inline code'))!
    // different elements, different whitespace, extra content in front
    const changed = parse(`<html><body><div class="new"><h1>Chapter One</h1><p>Inserted sentence.</p>
      <p>The quick brown fox jumps over the lazy dog.</p>
      <div>A <i>second</i>
         paragraph,   with <tt>inline
         code</tt> and the quick brown fox again.</div></div></body></html>`)
    const range = anchorQuote(changed.body, quote, position.start)!
    expect(range).not.toBeNull()
    expect(range.toString().replace(/\s+/g, ' ')).toBe('paragraph, with inline code')
  })

  it('returns null when the text is gone', () => {
    const doc = parse(PAGE)
    expect(anchorQuote(doc.body, { exact: 'not in this book', prefix: '', suffix: '' })).toBeNull()
  })
})

describe('CFIs', () => {
  it('round-trips a range', () => {
    const doc = parse(PAGE)
    const range = rangeOf(doc, 'paragraph, with inline code')
    const cfi = fromRange(range)
    expect(CFI.isCFI.test(cfi)).toBe(true)
    expect(toRange(doc, CFI.parse(cfi)).toString()).toBe('paragraph, with inline code')
  })

  it('are unaffected by nodes the reader injects', () => {
    const pristine = parse('<html><body><p>Energy is \\(E = mc^2\\) as everyone knows.</p></body></html>')
    const cfi = fromRange(rangeOf(pristine, 'as everyone knows'))

    // The same page after math rendering: the TeX source wrapped (skipped),
    // the rendered formula inserted (ignored).
    const live = parse('<html><body><p>Energy is \\(E = mc^2\\) as everyone knows.</p></body></html>')
    const text = live.querySelector('p')!.firstChild as Text
    const tail = text.splitText(text.data.indexOf(' as everyone'))
    const tex = text.splitText(text.data.indexOf('\\('))
    const wrapper = live.createElement('span')
    wrapper.setAttribute(SKIP, '')
    tex.replaceWith(wrapper)
    wrapper.append(tex)
    const formula = live.createElement('mjx-container')
    formula.setAttribute(IGNORE, '')
    formula.textContent = 'rendered'
    tail.before(formula)

    expect(toRange(live, CFI.parse(cfi)).toString()).toBe('as everyone knows')
    expect(fromRange(rangeOf(live, 'as everyone knows'))).toBe(cfi)
    // text anchoring ignores the injected node as well
    expect(textMap(live.body).text).toBe(textMap(pristine.body).text)
  })

  it('of a range that begins or ends inside a rendered formula still resolve', () => {
    const html = '<html><body><p>Energy is \\(E = mc^2\\) as everyone knows.</p><p>The end.</p></body></html>'
    const pristine = parse(html)
    const live = parse(html)
    const text = live.querySelector('p')!.firstChild as Text
    const tail = text.splitText(text.data.indexOf(' as everyone'))
    const tex = text.splitText(text.data.indexOf('\\('))
    const wrapper = live.createElement('span')
    wrapper.setAttribute(SKIP, '')
    tex.replaceWith(wrapper)
    wrapper.append(tex)
    const formula = live.createElement('mjx-container')
    formula.setAttribute(IGNORE, '')
    formula.innerHTML = '<svg><g><path></path><g><path></path></g></g></svg>'
    tail.before(formula)
    const inside = formula.querySelector('g g')!
    const last = live.querySelectorAll('p')[1].firstChild as Text

    // what is on screen from the formula on: the top of a view, say
    const from = live.createRange()
    from.setStart(inside, 0)
    from.setEnd(last, 3)
    // on the page before its math is rendered - where a book is reopened -
    // that is from the end of the formula's source
    expect(toRange(pristine, CFI.parse(fromRange(from))).toString()).toBe(' as everyone knows.The')
    expect(toRange(live, CFI.parse(fromRange(from))).toString()).toBe(' as everyone knows.The')

    const upTo = live.createRange()
    upTo.setStart(text, 0)
    upTo.setEnd(inside, 1)
    expect(toRange(pristine, CFI.parse(fromRange(upTo))).toString()).toBe('Energy is \\(E = mc^2\\)')
  })

  it('whose end is no longer in the document resolve to their start', () => {
    const doc = parse(PAGE)
    const cfi = fromRange(rangeOf(doc, 'quick brown fox'))
    const parts = CFI.parse(cfi)
    if (!('parent' in parts)) throw new Error('expected a range CFI')
    // (the kind of path a range ending inside a formula used to be given)
    parts.end = [[{ index: 26 }, { index: 4 }, { index: 1, offset: 1 }]]
    const range = toRange(doc, parts)
    expect(range.collapsed).toBe(true)
    expect(range.startContainer.nodeValue?.slice(range.startOffset, range.startOffset + 15)).toBe('quick brown fox')
  })
})

describe('repeated text with reflowed whitespace', () => {
  it('still uses the context to pick the right occurrence', () => {
    const text = 'x one  two y one  two z'
    const found = findQuote(text, { exact: 'one two', prefix: 'y ', suffix: ' z' })!
    expect(found.start).toBe(13)
    expect(text.slice(found.start, found.end)).toBe('one  two')
  })
})
