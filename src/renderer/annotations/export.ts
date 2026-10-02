import type { Annotation, Book, Bookmark } from '@shared/types'

/** YYYY-MM-DD in the reader's own time zone. */
const day = (time: number): string => {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Keeps multi-paragraph text inside one Markdown blockquote. */
const quote = (text: string): string =>
  text
    .trim()
    .split(/\n+/)
    .map(line => `> ${line.trim()}`)
    .join('\n>\n')

const inline = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function toMarkdown(
  book: Pick<Book, 'title' | 'author'>,
  annotations: Annotation[],
  bookmarks: Bookmark[] = [],
  now = Date.now(),
): string {
  const lines: string[] = [`# ${inline(book.title)}`, '']
  if (book.author) lines.push(`*${inline(book.author)}*`, '')
  const count = `${annotations.length} highlight${annotations.length === 1 ? '' : 's'}`
  lines.push(`Exported from BookViewer on ${day(now)} · ${count}`, '')

  let section: string | null = null
  for (const annotation of [...annotations].sort((a, b) => a.position - b.position || a.id - b.id)) {
    const label = inline(annotation.label) || 'Untitled section'
    if (label !== section) {
      lines.push(`## ${label}`, '')
      section = label
    }
    lines.push(quote(annotation.text), '')
    if (annotation.note.trim()) lines.push(`**Note:** ${annotation.note.trim()}`, '')
    lines.push(`<small>${annotation.color} · ${day(annotation.createdAt)}</small>`, '')
  }

  if (bookmarks.length) {
    lines.push('## Bookmarks', '')
    for (const bookmark of [...bookmarks].sort((a, b) => a.position - b.position)) {
      const percent = Math.round(bookmark.position * 100)
      const excerpt = inline(bookmark.excerpt)
      lines.push(`- **${inline(bookmark.label) || 'Bookmark'}** (${percent}%)${excerpt ? ` — ${excerpt}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function toJSON(
  book: Pick<Book, 'title' | 'author' | 'identifier' | 'format'>,
  annotations: Annotation[],
  bookmarks: Bookmark[] = [],
  now = Date.now(),
): string {
  return JSON.stringify(
    {
      book: {
        title: book.title,
        author: book.author,
        identifier: book.identifier,
        format: book.format,
      },
      exportedAt: new Date(now).toISOString(),
      annotations: annotations.map(a => ({
        text: a.text,
        note: a.note,
        color: a.color,
        style: a.style,
        section: a.label,
        position: a.position,
        selector: a.selector,
        created: new Date(a.createdAt).toISOString(),
        updated: new Date(a.updatedAt).toISOString(),
      })),
      bookmarks: bookmarks.map(b => ({
        section: b.label,
        excerpt: b.excerpt,
        position: b.position,
        location: b.location,
        created: new Date(b.createdAt).toISOString(),
      })),
    },
    null,
    2,
  )
}
