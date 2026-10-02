import type {
  Annotation,
  Bookmark,
  HighlightColor,
  HighlightStyle,
  NewAnnotation,
  NewBookmark,
} from '@shared/types'
import { ipc } from '../lib/ipc'

/** A book's highlights, notes and bookmarks, kept in step with the database. */
export class AnnotationStore {
  annotations = $state<Annotation[]>([])
  bookmarks = $state<Bookmark[]>([])

  constructor(readonly bookId: number) {}

  async load(): Promise<void> {
    const [annotations, bookmarks] = await Promise.all([
      ipc.invoke('annotations:list', this.bookId),
      ipc.invoke('bookmarks:list', this.bookId),
    ])
    this.annotations = annotations
    this.bookmarks = bookmarks
  }

  get(id: number): Annotation | undefined {
    return this.annotations.find(annotation => annotation.id === id)
  }

  private sort(): void {
    this.annotations.sort((a, b) => a.position - b.position || a.id - b.id)
  }

  async add(annotation: Omit<NewAnnotation, 'bookId'>): Promise<Annotation> {
    const saved = await ipc.invoke('annotations:add', { ...annotation, bookId: this.bookId })
    this.annotations.push(saved)
    this.sort()
    return saved
  }

  async update(
    id: number,
    patch: { note?: string; color?: HighlightColor; style?: HighlightStyle },
  ): Promise<void> {
    const saved = await ipc.invoke('annotations:update', id, patch)
    const at = this.annotations.findIndex(annotation => annotation.id === id)
    if (saved && at >= 0) this.annotations[at] = saved
  }

  async remove(id: number): Promise<void> {
    await ipc.invoke('annotations:remove', id)
    this.annotations = this.annotations.filter(annotation => annotation.id !== id)
  }

  async addBookmark(bookmark: Omit<NewBookmark, 'bookId'>): Promise<Bookmark> {
    const saved = await ipc.invoke('bookmarks:add', { ...bookmark, bookId: this.bookId })
    this.bookmarks.push(saved)
    this.bookmarks.sort((a, b) => a.position - b.position || a.id - b.id)
    return saved
  }

  async removeBookmark(id: number): Promise<void> {
    await ipc.invoke('bookmarks:remove', id)
    this.bookmarks = this.bookmarks.filter(bookmark => bookmark.id !== id)
  }
}
