import { createWriteStream, existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { net } from 'electron'
import type { OpdsResponse } from '@shared/types'
import { sanitizeFilename } from './util'

const MAX_FEED_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const MAX_BOOK_BYTES = 1024 * 1024 * 1024

const TYPE_EXTENSIONS: Record<string, string> = {
  'application/epub+zip': '.epub',
  'application/pdf': '.pdf',
  'application/x-mobipocket-ebook': '.mobi',
  'application/vnd.amazon.mobi8-ebook': '.azw3',
  'application/x-fictionbook+xml': '.fb2',
  'application/x-zip-compressed-fb2': '.fb2.zip',
  'application/vnd.comicbook+zip': '.cbz',
  'application/x-cbz': '.cbz',
}

function httpUrl(url: string): URL {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('Only http and https catalogs are supported')
  return parsed
}

/**
 * What went wrong, as a short code the catalog screen turns into a sentence
 * (see friendlyError in the renderer): only the message survives the trip
 * across IPC. Network failures already arrive as "net::ERR_...".
 */
const failure = {
  status: (response: Response) => new Error(`HTTP ${response.status}`),
  timeout: () => new Error('timeout'),
  tooLarge: () => new Error('too large'),
  notABook: () => new Error('not a book'),
}

/** Fetches with a deadline that also covers reading the body. */
async function request(url: string, accept: string, timeoutMs: number) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  /** The deadline shows up as a bare "aborted"; say what it really was. */
  const explain = (error: unknown): unknown => (timedOut ? failure.timeout() : error)
  try {
    const response = await net.fetch(httpUrl(url).href, {
      headers: { accept },
      signal: controller.signal,
    })
    return { response, controller, explain, done: () => clearTimeout(timer) }
  } catch (error) {
    clearTimeout(timer)
    throw explain(error)
  }
}

/** Reads a response body, giving up as soon as it is larger than `limit`. */
async function readLimited(
  response: Response,
  limit: number,
  controller: AbortController,
): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    controller.abort()
    throw failure.tooLarge()
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) {
        controller.abort()
        throw failure.tooLarge()
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export async function fetchOpds(url: string): Promise<OpdsResponse> {
  const { response, controller, explain, done } = await request(
    url,
    'application/atom+xml;profile=opds-catalog, application/opds+json, application/atom+xml, application/xml;q=0.9, */*;q=0.5',
    30_000,
  )
  try {
    if (!response.ok) throw failure.status(response)
    const bytes = await readLimited(response, MAX_FEED_BYTES, controller)
    return {
      url: response.url || url,
      contentType: response.headers.get('content-type') ?? '',
      body: new TextDecoder().decode(bytes),
    }
  } catch (error) {
    controller.abort()
    throw explain(error)
  } finally {
    done()
  }
}

export async function fetchImage(url: string): Promise<{ type: string; bytes: Uint8Array } | null> {
  try {
    const { response, controller, done } = await request(url, 'image/*', 20_000)
    try {
      if (!response.ok) return null
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!type.startsWith('image/')) {
        controller.abort()
        return null
      }
      return { type, bytes: await readLimited(response, MAX_IMAGE_BYTES, controller) }
    } finally {
      done()
    }
  } catch {
    return null
  }
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ''))
    } catch {
      // fall through to the plain form
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim() ?? null
}

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** The book extension in a download's file name (from its headers, else its URL), if it has one. */
function namedExtension(disposition: string | null, pathname: string): string | null {
  const fromUrl = safeDecode(pathname.split('/').pop() ?? '')
  for (const candidate of [filenameFromDisposition(disposition), fromUrl]) {
    if (!candidate) continue
    if (/\.fb2\.zip$/i.test(candidate)) return '.fb2.zip'
    if (/\.(epub|pdf|mobi|azw3?|fb2|fbz|cbz)$/i.test(candidate)) return extname(candidate).toLowerCase()
  }
  return null
}

/** Whether a response is a book file we can keep (going by its type, else its name). */
export function isBookDownload(contentType: string, pathname: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase()
  return type in TYPE_EXTENSIONS || !!namedExtension(null, pathname)
}

/** The extension a download should get, from its headers and URL. */
export function downloadExtension(
  contentType: string,
  disposition: string | null,
  pathname: string,
): string {
  const type = contentType.split(';')[0].trim().toLowerCase()
  return namedExtension(disposition, pathname) ?? TYPE_EXTENSIONS[type] ?? '.epub'
}

export async function downloadBook(
  url: string,
  folder: string,
  suggestedName: string,
): Promise<string> {
  const { response, controller, explain, done } = await request(url, '*/*', 15 * 60_000)
  let target = ''
  try {
    if (!response.ok) throw failure.status(response)
    if (Number(response.headers.get('content-length') ?? 0) > MAX_BOOK_BYTES) throw failure.tooLarge()
    // A sign-in or error page served in place of the file would otherwise be
    // saved under a book's name and sit in the library unreadable.
    const contentType = response.headers.get('content-type') ?? ''
    const disposition = response.headers.get('content-disposition')
    const { pathname } = new URL(url)
    if (/^text\/html\b/i.test(contentType.trim()) && !namedExtension(disposition, pathname))
      throw failure.notABook()

    const extension = downloadExtension(contentType, disposition, pathname)
    let name = sanitizeFilename(suggestedName) || 'book'
    if (!name.toLowerCase().endsWith(extension)) name += extension
    const stem = name.slice(0, name.length - extension.length)
    target = join(folder, name)
    for (let n = 1; existsSync(target); n++) target = join(folder, `${stem} (${n})${extension}`)

    // Straight to disk (under a name the scanner ignores until it is whole).
    const partial = target + '.part'
    const file = createWriteStream(partial)
    try {
      let total = 0
      const reader = response.body?.getReader()
      if (reader) {
        for (;;) {
          const { done: finished, value } = await reader.read()
          if (finished) break
          total += value.length
          if (total > MAX_BOOK_BYTES) throw failure.tooLarge()
          if (!file.write(value)) await new Promise<void>(resolve => file.once('drain', () => resolve()))
        }
      }
      await new Promise<void>((resolve, reject) => {
        file.once('error', reject)
        file.end(() => resolve())
      })
      await rename(partial, target)
    } catch (error) {
      file.destroy()
      await rm(partial, { force: true })
      throw error
    }
    return target
  } catch (error) {
    controller.abort()
    throw explain(error)
  } finally {
    done()
  }
}
