import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanFolder } from '../../src/main/library'
import { grabUrl, isPrivateHost, type Fetch } from '../../src/main/webgrab'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookviewer-grab-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/theme/site.css">
   <script src="/evil.js"></script></head><body>${body}</body></html>`

const SITE: Record<string, { type: string; body: string }> = {
  'https://book.test/': {
    type: 'text/html; charset=utf-8',
    body: page(
      'The Web Book',
      `<nav><ul><li><a href="#">Social links</a></li><li><a href="/">Home</a></li></ul></nav>
       <h1>The Web Book</h1><ul>
         <li><a href="/3e/chapter1.html">Chapter 1</a></li>
         <li><a href="/3e/chapter2.html#part">Chapter 2</a></li>
         <li><a href="https://elsewhere.test/shop">Buy</a></li>
         <li><a href="/files/book.pdf">PDF</a></li>
       </ul>`,
    ),
  },
  'https://book.test/3e/chapter1.html': {
    type: 'text/html',
    body: page('Chapter 1', '<h1>Chapter 1</h1><p>First words.</p><img src="../images/fig 1.png"><img src="http://192.168.1.1/admin.png"><a href="chapter2.html">next</a>'),
  },
  'https://book.test/3e/chapter2.html': {
    type: 'text/html',
    body: page('Chapter 2', '<h1>Chapter 2</h1><p>More words.</p><img data-src="https://cdn.test/fig2.png" src="data:image/gif;base64,AAAA"><a href="/">home</a>'),
  },
  'https://book.test/theme/site.css': { type: 'text/css', body: 'body { color: black }' },
  'https://book.test/images/fig%201.png': { type: 'image/png', body: 'PNG1' },
  'https://cdn.test/fig2.png': { type: 'image/png', body: 'PNG2' },
  'https://book.test/files/book.pdf': { type: 'application/pdf', body: '%PDF' },
}

const requested: string[] = []
const fakeFetch: Fetch = async url => {
  requested.push(url)
  const hit = SITE[url]
  if (!hit) return new Response('nope', { status: 404 })
  const response = new Response(hit.body, { headers: { 'content-type': hit.type } })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

describe('saving a book from the web', () => {
  it('saves the page and the pages it links to as a site the scanner reads as one book', async () => {
    requested.length = 0
    const result = await grabUrl({ url: 'https://book.test/', folder: dir, scope: 'site' }, fakeFetch)
    expect(result).toMatchObject({ kind: 'site', title: 'The Web Book', pages: 3 })
    const root = join(dir, 'The Web Book')
    expect(existsSync(join(root, '3e', 'chapter1.html'))).toBe(true)
    // nothing half-written is left behind
    expect((await readdir(dir)).filter(name => name.startsWith('.'))).toEqual([])
    // other sites and files are not followed
    expect(requested).not.toContain('https://elsewhere.test/shop')
    expect(requested).not.toContain('https://book.test/files/book.pdf')
    // nor is anything fetched from the reader's own network on a page's say-so
    expect(requested).not.toContain('http://192.168.1.1/admin.png')

    const index = await readFile(join(root, 'index.html'), 'utf8')
    expect(index).toContain('href="3e/chapter1.html"')
    expect(index).toContain('href="3e/chapter2.html#part"')
    expect(index).toContain('href="https://elsewhere.test/shop"')
    expect(index).toContain('href="https://book.test/files/book.pdf"')
    expect(index).not.toContain('<script')
    expect(index).toContain('href="_assets/book.test/theme/site.css"')

    const one = await readFile(join(root, '3e', 'chapter1.html'), 'utf8')
    expect(one).toContain('src="../_assets/book.test/images/fig%201.png"')
    expect(one).toContain('href="chapter2.html"')
    expect(await readFile(join(root, '_assets', 'book.test', 'images', 'fig 1.png'), 'utf8')).toBe('PNG1')
    const two = await readFile(join(root, '3e', 'chapter2.html'), 'utf8')
    expect(two).toContain('src="../_assets/cdn.test/fig2.png"')
    expect(two).toContain('href="../index.html"')

    const books = await scanFolder(dir)
    expect(books).toHaveLength(1)
    expect(books[0].format).toBe('web')
    expect(books[0].manifest?.pages.map(p => p.href)).toEqual(['index.html', '3e/chapter1.html', '3e/chapter2.html'])
  })

  it('saves just the one page when asked to', async () => {
    requested.length = 0
    const result = await grabUrl({ url: 'https://book.test/3e/chapter1.html', folder: dir, scope: 'page' }, fakeFetch)
    expect(result).toMatchObject({ kind: 'site', title: 'Chapter 1', pages: 1 })
    expect(requested.filter(url => url.endsWith('.html'))).toEqual(['https://book.test/3e/chapter1.html'])
    const saved = await readFile(join(dir, 'Chapter 1', 'index.html'), 'utf8')
    expect(saved).toContain('href="https://book.test/3e/chapter2.html"')
  })

  it('hands a file back to be downloaded as it is, and explains what it cannot do', async () => {
    expect(await grabUrl({ url: 'https://book.test/files/book.pdf', folder: dir, scope: 'site' }, fakeFetch)).toEqual({
      kind: 'file',
      contentType: 'application/pdf',
    })
    await expect(grabUrl({ url: 'ftp://book.test/', folder: dir, scope: 'site' }, fakeFetch)).rejects.toThrow(/http/)
    await expect(grabUrl({ url: 'https://book.test/missing', folder: dir, scope: 'site' }, fakeFetch)).rejects.toThrow(/404/)
    expect(await readdir(dir)).toEqual([])
  })

  it('knows an address on the local network when it sees one', () => {
    for (const host of ['localhost', 'printer.local', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.9', '169.254.1.1', '[::1]', 'fd12:3456::1'])
      expect(isPrivateHost(host), host).toBe(true)
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '193.168.0.1', 'localhost.example.com'])
      expect(isPrivateHost(host), host).toBe(false)
  })

  it('leaves nothing behind when cancelled', async () => {
    const controller = new AbortController()
    const slow: Fetch = async (url, init) => {
      if (url.includes('chapter')) controller.abort()
      return fakeFetch(url, init)
    }
    await expect(
      grabUrl({ url: 'https://book.test/', folder: dir, scope: 'site', signal: controller.signal }, slow),
    ).rejects.toThrow('Cancelled')
    expect(await readdir(dir)).toEqual([])
  })
})
