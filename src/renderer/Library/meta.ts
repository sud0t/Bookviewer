/**
 * Fills in titles, authors and covers for newly scanned books. This runs in
 * the renderer because that is where the format engines (foliate-js, pdf.js)
 * and a canvas live; the main process only stores the results.
 */
import { bookUrl, type Book, type BookMeta } from '@shared/types'
import { app, refreshBook } from '../lib/app.svelte'
import { ipc } from '../lib/ipc'
import { contributors, localizedText, openFoliateBook, fileName } from '../engines/formats'

const COVER_WIDTH = 480
const COVER_MAX_HEIGHT = 800

type CoverSource = Blob | HTMLCanvasElement | OffscreenCanvas

async function toWebp(source: CoverSource): Promise<Uint8Array | null> {
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(source)
    if (!bitmap.width || !bitmap.height) return null
    const scale = Math.min(1, COVER_WIDTH / bitmap.width, COVER_MAX_HEIGHT / bitmap.height)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')!
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 })
    return new Uint8Array(await blob.arrayBuffer())
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

interface Extracted {
  meta: BookMeta
  cover: Uint8Array | null
}

async function fromFoliate(book: Book): Promise<Extracted> {
  const opened = await openFoliateBook(book)
  try {
    const metadata = opened.metadata ?? {}
    const language = Array.isArray(metadata.language) ? metadata.language[0] : metadata.language
    const blob = await Promise.resolve(opened.getCover?.()).catch(() => null)
    // A comic book's "title" is just its file name; keep the tidier one we have.
    const title = book.format === 'cbz' ? '' : localizedText(metadata.title)
    return {
      meta: {
        title,
        author: contributors(metadata.author),
        description: stripHtml(metadata.description ?? ''),
        language: language ?? '',
        publisher: contributors(metadata.publisher),
        published: metadata.published ?? '',
        identifier: metadata.identifier ?? '',
      },
      cover: blob ? await toWebp(blob) : null,
    }
  } finally {
    opened.destroy?.()
  }
}

const stripHtml = (html: string): string => {
  if (!html.includes('<')) return html.trim()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** PDF producers often leave junk in the Title field. */
const usablePdfTitle = (title: unknown): string => {
  if (typeof title !== 'string') return ''
  const clean = title.replace(/\s+/g, ' ').trim()
  if (clean.length < 3) return ''
  if (/^(untitled|microsoft word|powerpoint|document\d*$)/i.test(clean)) return ''
  if (/\.(docx?|pdf|indd|qxd|dvi|tex|pptx?|rtf|odt)$/i.test(clean)) return ''
  return clean
}

async function fromPdf(book: Book): Promise<Extracted> {
  const { loadPdf } = await import('../engines/pdfjs')
  const task = loadPdf(bookUrl(book.id, fileName(book.path)))
  try {
    const pdf = await task.promise
    const { info } = await pdf.getMetadata().catch(() => ({ info: {} }))
    const fields = info as Record<string, unknown>
    const page = await pdf.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: (COVER_WIDTH * 1.5) / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    const cover = await toWebp(canvas)
    canvas.width = canvas.height = 0
    return {
      meta: {
        title: usablePdfTitle(fields.Title),
        author: typeof fields.Author === 'string' ? fields.Author.trim() : '',
      },
      cover,
    }
  } finally {
    await task.destroy()
  }
}

async function fromWeb(book: Book): Promise<Extracted> {
  const manifest = await ipc.invoke('books:manifest', book.id)
  if (!manifest) throw new Error('No manifest')
  let cover: Uint8Array | null = null
  if (manifest.cover) {
    try {
      const response = await fetch(bookUrl(book.id, manifest.cover))
      if (response.ok) {
        const blob = await response.blob()
        const bitmap = await createImageBitmap(blob)
        const { width, height } = bitmap
        bitmap.close()
        // Logos and icons make poor covers; want something picture-sized.
        const ratio = width / height
        if (width >= 240 && height >= 240 && ratio > 0.4 && ratio < 2.4) cover = await toWebp(blob)
      }
    } catch {
      // no usable cover image
    }
  }
  return {
    meta: {
      title: manifest.title,
      author: manifest.author,
      description: manifest.description,
      language: manifest.language,
    },
    cover,
  }
}

export function extractMeta(book: Book): Promise<Extracted> {
  if (book.format === 'pdf') return fromPdf(book)
  if (book.format === 'web') return fromWeb(book)
  return fromFoliate(book)
}

let running = false

/** Works through every book still waiting for metadata, one at a time. */
export async function processPending(): Promise<void> {
  if (running) return
  running = true
  try {
    const attempted = new Set<number>()
    for (;;) {
      const book = app.books.find(b => b.metaState === 'pending' && !attempted.has(b.id))
      if (!book) break
      attempted.add(book.id)
      try {
        const { meta, cover } = await extractMeta(book)
        await ipc.invoke('books:setMeta', book.id, meta, cover)
      } catch (error) {
        console.warn(`Reading metadata of ${book.path} failed:`, error)
        await ipc.invoke('books:setMeta', book.id, null, null)
      }
      await refreshBook(book.id)
    }
  } finally {
    running = false
  }
}
