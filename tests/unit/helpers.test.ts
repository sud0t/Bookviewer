// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fixWavHeader } from '../../src/main/tts'
import { parseRange, safeJoin, sanitizeFilename } from '../../src/main/util'
import { preInvert } from '../../src/renderer/engines/appearance'
import { splitMath } from '../../src/renderer/engines/math'
import { findInLayer, layerText } from '../../src/renderer/engines/pdf-text'
import { mergeRects } from '../../src/renderer/engines/rects'
import { openSearchUrl } from '../../src/renderer/Library/opds'

describe('range requests', () => {
  it('parses the common forms', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
  })
  it('rejects what it cannot serve', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=9-2', 100)).toBe('invalid')
    expect(parseRange('lines=1-2', 100)).toBe('invalid')
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid')
  })
})

describe('paths', () => {
  it('keeps requests inside the book root', () => {
    expect(safeJoin('/books/rust', '/ch01.html')).toBe('/books/rust/ch01.html')
    expect(safeJoin('/books/rust', '/css/../ch01.html')).toBe('/books/rust/ch01.html')
    expect(safeJoin('/books/rust', '/../other/secret')).toBeNull()
    expect(safeJoin('/books/rust', '/../rust-private/x')).toBeNull()
  })
  it('makes safe file names', () => {
    expect(sanitizeFilename('Moby Dick; Or, The Whale')).toBe('Moby Dick; Or, The Whale')
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc passwd')
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
  })
})

describe('speech audio', () => {
  it('fills in the length fields espeak leaves open', () => {
    const wav = Buffer.alloc(44 + 10)
    wav.write('RIFF', 0, 'latin1')
    wav.writeUInt32LE(0xffffffff, 4)
    wav.write('WAVEfmt ', 8, 'latin1')
    wav.writeUInt32LE(16, 16)
    wav.write('data', 36, 'latin1')
    wav.writeUInt32LE(0xffffffff, 40)
    const fixed = fixWavHeader(wav)
    expect(fixed.readUInt32LE(4)).toBe(54 - 8)
    expect(fixed.readUInt32LE(40)).toBe(10)
  })
})

describe('PDF highlight rectangles', () => {
  it('joins the spans of one line and keeps lines apart', () => {
    const merged = mergeRects([
      [10, 100, 60, 112],
      [62, 100, 120, 112],
      [10, 80, 90, 92],
      [121, 100.5, 180, 112.5],
    ])
    expect(merged).toEqual([
      [10, 100, 180, 112.5],
      [10, 80, 90, 92],
    ])
  })
  it('does not bridge a wide gap (two columns)', () => {
    expect(mergeRects([[10, 100, 60, 112], [300, 100, 360, 112]])).toHaveLength(2)
    // whichever of the two happens to sit a hair higher
    expect(mergeRects([[50, 690, 280, 700], [320, 690.3, 550, 700.3]])).toHaveLength(2)
    expect(mergeRects([[320, 690, 550, 700], [50, 690.3, 280, 700.3]])).toHaveLength(2)
  })
})

describe('themes', () => {
  it('pre-inverts colours so that the dark filter lands on them', () => {
    expect(preInvert('#000000')).toBe('#ffffff')
    expect(preInvert('#ffffff')).toBe('#000000')
    // near-neutral colours stay near-neutral
    const [r, g, b] = preInvert('#1c1b1a').match(/[0-9a-f]{2}/g)!.map(h => parseInt(h, 16))
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(8)
    expect(r).toBeGreaterThan(215)
  })
})

describe('math detection', () => {
  it('finds inline and display formulas', () => {
    const pieces = splitMath('Let \\(x^2\\) be given: \\[ \\int_0^1 f \\] and $$a=b$$ done')!
    expect(pieces.filter(p => p.tex != null).map(p => [p.tex!.trim(), p.display])).toEqual([
      ['x^2', false],
      ['\\int_0^1 f', true],
      ['a=b', true],
    ])
    expect(pieces.map(p => p.text).join('')).toBe('Let \\(x^2\\) be given: \\[ \\int_0^1 f \\] and $$a=b$$ done')
  })
  it('finds bare environments', () => {
    const pieces = splitMath('see \\begin{align*} a &= b \\end{align*} here')!
    expect(pieces[1].tex).toContain('\\begin{align*}')
    expect(pieces[1].display).toBe(true)
  })
  it('leaves prose about escaped parentheses alone', () => {
    expect(splitMath('The \\( and \\) characters match literal parentheses.')).toBeNull()
    expect(splitMath('No math here.')).toBeNull()
  })
})

describe('OpenSearch', () => {
  it('prefers the catalog URL over the HTML one', () => {
    const doc = new DOMParser().parseFromString(
      `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
         <Url type="text/html" template="https://example.org/search?q={searchTerms}"/>
         <Url type="application/atom+xml" template="https://example.org/opds/search?q={searchTerms}&amp;page={startPage?}"/>
       </OpenSearchDescription>`,
      'application/xml',
    )
    expect(openSearchUrl(doc, 'moby dick')).toBe('https://example.org/opds/search?q=moby%20dick&page=1')
  })
})

describe('PDF text layer', () => {
  // what pdf.js renders: one span per run of text, a <br> where a line ends
  const layer = () => {
    const doc = new DOMParser().parseFromString(
      `<div class="textLayer"><span>The process keeps</span><br><span>running while the docu-</span><br>` +
        `<span>ment is open. </span><span>Second sentence here.</span><br></div>`,
      'text/html',
    )
    return doc.querySelector('.textLayer')!
  }

  it('reads line ends as word breaks and rejoins hyphenated words', () => {
    expect(layerText(layer())).toBe(
      'The process keeps running while the document is open. Second sentence here.',
    )
  })

  it('reads just the selected part', () => {
    const el = layer()
    const range = el.ownerDocument.createRange()
    range.setStart(el.querySelectorAll('span')[0].firstChild!, 12)
    range.setEnd(el.querySelectorAll('span')[1].firstChild!, 7)
    expect(layerText(el, range)).toBe('keeps running')
  })

  it('finds a sentence that wraps and was de-hyphenated', () => {
    const el = layer()
    const range = findInLayer(el, 'The process keeps running while the document is open.')!
    expect(range).not.toBeNull()
    expect(range.startContainer.nodeValue).toBe('The process keeps')
    expect(range.startOffset).toBe(0)
    expect(range.endContainer.nodeValue).toBe('ment is open. ')
    expect(range.endOffset).toBe('ment is open.'.length)
    expect(findInLayer(el, 'Second sentence here.')!.toString()).toBe('Second sentence here.')
    expect(findInLayer(el, 'Not on this page.')).toBeNull()
  })
})
