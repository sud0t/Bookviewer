/**
 * Fills in titles, authors and covers for newly scanned books. This runs in
 * the renderer because that is where the format engines (foliate-js, pdf.js)
 * and a canvas live; the main process only stores the results.
 */
import { bookUrl, type Book, type BookMeta } from '@shared/types'
import { app, refreshBook } from '../lib/app.svelte'
import { ipc } from '../lib/ipc'
import type { FoliateBook } from 'foliate-js/types'
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

/** A published book's cover from the web, for a file that brings none. */
async function onlineCover(title: string, author: string): Promise<Uint8Array | null> {
  if (!app.settings.onlineCovers || !title) return null
  const bytes = await ipc.invoke('lookup:cover', title, author).catch(() => null)
  return bytes ? toWebp(new Blob([bytes as BlobPart])) : null
}

const PAGE = { width: 600, height: 900 }
const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

/**
 * The last resort for a cover: a picture of the book's first page, the way
 * a PDF's is made. The page is drawn through an SVG image, which may not
 * load anything from outside itself, so its pictures and styles are put in.
 */
async function firstPage(opened: FoliateBook): Promise<Uint8Array | null> {
  const section = opened.sections.find(s => s.linear !== 'no' && s.createDocument)
  const doc = await section?.createDocument?.()
  if (!section || !doc?.body) return null
  const resolve = (href: string | null) => (href ? (section.resolveHref?.(href) ?? href) : null)
  for (const node of doc.body.querySelectorAll('script, iframe, object, embed, video, audio, link, form'))
    node.remove()
  let pictures = 0
  for (const image of doc.body.querySelectorAll('img, image')) {
    const attribute = image.hasAttribute('src') ? 'src' : image.hasAttribute('href') ? 'href' : 'xlink:href'
    const path = resolve(image.getAttribute(attribute))
    const blob = path && pictures < 6 ? await Promise.resolve(opened.loadBlob?.(path)).catch(() => null) : null
    if (!blob || blob.size > 3_000_000) {
      image.remove()
      continue
    }
    pictures++
    image.setAttribute(attribute, await blobToDataUrl(blob))
    image.removeAttribute('srcset')
  }
  let css = ''
  for (const link of doc.querySelectorAll('link[rel~="stylesheet"]')) {
    const path = resolve(link.getAttribute('href'))
    css += (path && (await Promise.resolve(opened.loadText?.(path)).catch(() => ''))) || ''
  }
  for (const style of doc.querySelectorAll('style')) css += style.textContent ?? ''
  // nothing that reaches outside the image, and no dark variants
  css = css
    .replace(/@import[^;]*;/g, '')
    .replace(/@font-face\s*\{[^}]*\}/g, '')
    .replace(/@media[^{]*prefers-color-scheme[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
    .replace(/url\([^)]*\)/g, 'none')
    .replace(/<\/?style/gi, '')
  const serializer = new XMLSerializer()
  const content = [...doc.body.childNodes].slice(0, 60).map(node => serializer.serializeToString(node)).join('')
  if (!doc.body.textContent?.trim() && !pictures) return null
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE.width}" height="${PAGE.height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${PAGE.width}px;height:${PAGE.height}px;` +
    `box-sizing:border-box;overflow:hidden;padding:44px 40px;background:#fff;color:#1f1d1a;` +
    `font:19px/1.45 Georgia,'Liberation Serif',serif">` +
    `<style>${css.replace(/&/g, '&amp;').replace(/</g, '&lt;')} img,svg{max-width:100%;height:auto}</style>` +
    `${content}</div></foreignObject></svg>`
  const image = new Image()
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await image.decode()
  const canvas = new OffscreenCanvas(PAGE.width, PAGE.height)
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return toWebp(canvas)
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
    const author = contributors(metadata.author)
    const cover =
      (blob && (await toWebp(blob))) ||
      (book.format === 'cbz' ? null : await onlineCover(localizedText(metadata.title), author)) ||
      (await firstPage(opened).catch(() => null))
    // A comic book's "title" is just its file name; keep the tidier one we have.
    const title = book.format === 'cbz' ? '' : localizedText(metadata.title)
    return {
      meta: {
        title,
        author,
        description: stripHtml(metadata.description ?? ''),
        language: language ?? '',
        publisher: contributors(metadata.publisher),
        published: metadata.published ?? '',
        identifier: metadata.identifier ?? '',
      },
      cover,
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
