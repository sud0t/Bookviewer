import type { Book } from '@shared/types'
import type { Engine, EngineEvents } from './types'

/** Picks and prepares the engine for a book's format. */
export async function createEngine(book: Book, events: EngineEvents): Promise<Engine> {
  if (book.format === 'pdf') {
    const { PdfEngine } = await import('./pdf')
    return new PdfEngine(book, events)
  }
  if (book.format === 'web') {
    const { openWebBook } = await import('./webbook')
    return openWebBook(book, events)
  }
  const [{ ReflowEngine }, { openFoliateBook }] = await Promise.all([
    import('./epub'),
    import('./formats'),
  ])
  return new ReflowEngine(await openFoliateBook(book), events, { comic: book.format === 'cbz' })
}
