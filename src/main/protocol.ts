/**
 * `book://` serves book content to the renderer, which never touches the
 * filesystem itself:
 *
 *   book://b<id>/<path>   a book's file, or a file under a web book's root
 *   book://cover/<id>     a cached cover image
 *
 * `app://bundle/` serves the built renderer. Both get a real origin, which
 * `file://` pages do not have.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import type { Store } from './db'
import { coverFile } from './covers'
import { parseRange, safeJoin } from './util'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.cbz': 'application/vnd.comicbook+zip',
  '.fb2': 'application/x-fictionbook+xml',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
}

const mimeOf = (path: string): string => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
    {
      scheme: 'book',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

const text = (status: number, message: string): Response =>
  new Response(message, { status, headers: { 'content-type': 'text/plain' } })

async function serveFile(
  request: Request,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  let info
  try {
    info = await stat(path)
  } catch {
    return text(404, 'Not found')
  }
  if (!info.isFile()) return text(404, 'Not found')

  const headers = new Headers({
    'content-type': mimeOf(path),
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Accept-Ranges, Content-Length, Content-Range',
    'cache-control': 'no-cache',
    ...extraHeaders,
  })
  const range = parseRange(request.headers.get('range'), info.size)
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${info.size}`)
    return new Response(null, { status: 416, headers })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? info.size - 1
  headers.set('content-length', String(Math.max(0, end - start + 1)))
  if (range) headers.set('content-range', `bytes ${start}-${end}/${info.size}`)
  if (request.method === 'HEAD' || info.size === 0)
    return new Response(null, { status: range ? 206 : 200, headers })

  const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
  return new Response(stream, { status: range ? 206 : 200, headers })
}

type Target = { file: string } | { root: string }

export function handleBookProtocol(store: Store, coversDir: string): void {
  // A page pulls in dozens of resources; don't hit the database for each.
  const cache = new Map<number, { target: Target | null; at: number }>()
  const locate = async (id: number): Promise<Target | null> => {
    const cached = cache.get(id)
    if (cached && Date.now() - cached.at < 5000) return cached.target
    const book = store.getBook(id)
    let target: Target | null = null
    if (book && book.format !== 'web') target = { file: book.path }
    else if (book) {
      // A single saved page is a book whose root is the page's directory.
      const isDir = await stat(book.path).then(
        info => info.isDirectory(),
        () => false,
      )
      target = { root: isDir ? book.path : dirname(book.path) }
    }
    cache.set(id, { target, at: Date.now() })
    return target
  }

  protocol.handle('book', async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Method not allowed')
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return text(400, 'Bad request')
    }

    if (url.hostname === 'cover') {
      const id = Number(url.pathname.slice(1))
      if (!Number.isInteger(id)) return text(404, 'Not found')
      return serveFile(request, coverFile(coversDir, id), {
        'content-type': 'image/webp',
        'cache-control': 'max-age=31536000, immutable',
      })
    }

    const match = /^b(\d+)$/.exec(url.hostname)
    const target = match ? await locate(Number(match[1])) : null
    if (!target) return text(404, 'Not found')
    if ('file' in target) return serveFile(request, target.file)

    let relative: string
    try {
      relative = decodeURIComponent(url.pathname)
    } catch {
      return text(400, 'Bad request')
    }
    const path = safeJoin(target.root, relative)
    if (!path) return text(403, 'Forbidden')
    return serveFile(request, path, {
      // Pages are only ever fetched and re-rendered by the reader, but should
      // one be loaded as a document anyway, it must not be able to run code.
      'content-security-policy': "sandbox; script-src 'none'; object-src 'none'",
    })
  })
}

export function handleAppProtocol(rendererDir: string): void {
  protocol.handle('app', async request => {
    const url = new URL(request.url)
    if (url.hostname !== 'bundle') return text(404, 'Not found')
    let relative = decodeURIComponent(url.pathname)
    if (relative === '/' || relative === '') relative = '/index.html'
    const path = safeJoin(rendererDir, relative)
    if (!path) return text(403, 'Forbidden')
    return serveFile(request, path, { 'cache-control': 'no-cache' })
  })
}
