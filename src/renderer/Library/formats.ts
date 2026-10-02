import type { Book, BookFormat } from '@shared/types'

export const FORMAT_LABELS: Record<BookFormat, string> = {
  epub: 'EPUB',
  mobi: 'MOBI',
  azw3: 'AZW3',
  fb2: 'FB2',
  fbz: 'FB2',
  cbz: 'CBZ',
  pdf: 'PDF',
  web: 'WEB',
}

export interface FormatGroup {
  id: string
  label: string
  formats: BookFormat[]
}

export const FORMAT_GROUPS: FormatGroup[] = [
  { id: 'epub', label: 'EPUB', formats: ['epub'] },
  { id: 'pdf', label: 'PDF', formats: ['pdf'] },
  { id: 'web', label: 'Web books', formats: ['web'] },
  { id: 'kindle', label: 'Kindle', formats: ['mobi', 'azw3'] },
  { id: 'fb2', label: 'FictionBook', formats: ['fb2', 'fbz'] },
  { id: 'comics', label: 'Comics', formats: ['cbz'] },
]

export type LibraryFilter =
  | { kind: 'all' }
  | { kind: 'reading' }
  | { kind: 'format'; group: string }
  | { kind: 'folder'; id: number }

export function matchesFilter(book: Book, filter: LibraryFilter): boolean {
  switch (filter.kind) {
    case 'all':
      return true
    case 'reading':
      return book.progress > 0 && book.progress < 0.99
    case 'format':
      return FORMAT_GROUPS.find(group => group.id === filter.group)?.formats.includes(book.format) ?? false
    case 'folder':
      return book.folderId === filter.id
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
/** Sort titles the way a shelf would: ignoring a leading article. */
const sortKey = (title: string): string => title.replace(/^(the|an?)\s+/i, '')

export function sortBooks(books: Book[], order: string): Book[] {
  const byTitle = (a: Book, b: Book) => collator.compare(sortKey(a.title), sortKey(b.title))
  const sorted = [...books]
  switch (order) {
    case 'title':
      return sorted.sort(byTitle)
    case 'author':
      return sorted.sort((a, b) => collator.compare(a.author, b.author) || byTitle(a, b))
    case 'added':
      return sorted.sort((a, b) => b.addedAt - a.addedAt || byTitle(a, b))
    case 'progress':
      return sorted.sort((a, b) => b.progress - a.progress || byTitle(a, b))
    default:
      // most recently opened first, then unopened books by title
      return sorted.sort(
        (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || byTitle(a, b),
      )
  }
}
