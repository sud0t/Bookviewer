import { describe, expect, it } from 'vitest'
import type { Annotation, Bookmark } from '../../src/shared/types'
import { toJSON, toMarkdown } from '../../src/renderer/annotations/export'

const annotation = (patch: Partial<Annotation>): Annotation => ({
  id: 1,
  bookId: 1,
  selector: { type: 'cfi', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', quote: { exact: 'Hello', prefix: '', suffix: '' } },
  text: 'Hello',
  note: '',
  color: 'yellow',
  style: 'highlight',
  label: 'Chapter 1',
  position: 0.1,
  createdAt: new Date(2026, 0, 2, 12).getTime(),
  updatedAt: new Date(2026, 0, 2, 12).getTime(),
  ...patch,
})

const book = { title: 'A Book', author: 'An Author', identifier: 'urn:x', format: 'epub' as const }
const NOW = new Date(2026, 5, 1, 12).getTime()

describe('annotation export', () => {
  it('groups highlights by chapter, in reading order', () => {
    const markdown = toMarkdown(
      book,
      [
        annotation({ id: 2, text: 'Later', label: 'Chapter 2', position: 0.6 }),
        annotation({ id: 1, text: 'First\n\nsecond paragraph', note: 'my note', position: 0.1 }),
        annotation({ id: 3, text: 'Also chapter 2', label: 'Chapter 2', position: 0.7 }),
      ],
      [],
      NOW,
    )
    expect(markdown).toContain('# A Book')
    expect(markdown).toContain('*An Author*')
    expect(markdown).toContain('3 highlights')
    expect(markdown).toContain('2026-06-01')
    expect(markdown.indexOf('## Chapter 1')).toBeLessThan(markdown.indexOf('## Chapter 2'))
    expect(markdown.match(/## Chapter 2/g)).toHaveLength(1)
    expect(markdown).toContain('> First\n>\n> second paragraph')
    expect(markdown).toContain('**Note:** my note')
  })

  it('lists bookmarks', () => {
    const bookmark: Bookmark = {
      id: 1,
      bookId: 1,
      location: 'x',
      label: 'Chapter 3',
      excerpt: 'It was a dark night',
      position: 0.42,
      createdAt: NOW,
    }
    expect(toMarkdown(book, [], [bookmark], NOW)).toContain('- **Chapter 3** (42%) — It was a dark night')
  })

  it('produces JSON that keeps the selectors', () => {
    const data = JSON.parse(toJSON(book, [annotation({ note: 'n' })], [], NOW))
    expect(data.book.title).toBe('A Book')
    expect(data.annotations[0].selector.type).toBe('cfi')
    expect(data.annotations[0].note).toBe('n')
    expect(data.exportedAt).toBe(new Date(NOW).toISOString())
  })
})
