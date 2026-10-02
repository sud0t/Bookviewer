import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../../src/main/db'
import { Library, scanFolder } from '../../src/main/library'

// Downloads go through Electron's network stack; only the pure helper is under test.
vi.mock('electron', () => ({ net: {} }))
const { downloadExtension } = await import('../../src/main/opds')

let dir: string
let store: Store
let library: Library

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookviewer-lib-'))
  store = new Store(join(dir, 'library.db'))
  library = new Library(store, { changed() {}, progress() {} })
})

afterEach(async () => {
  await library.stop()
  store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('scanning', () => {
  it('recovers when a folder that was missing comes back', async () => {
    const path = join(dir, 'books')
    await mkdir(path)
    const folder = library.addFolder(path)!
    await library.scan(folder.id)
    await rm(path, { recursive: true })

    // a scan with nothing to walk must not leave itself marked as running
    await library.scan(folder.id)
    await library.scan(folder.id)

    await mkdir(path)
    await writeFile(join(path, 'Back Again.epub'), 'PK')
    await library.scan(folder.id)
    expect(store.listBooks().map(book => book.title)).toEqual(['Back Again'])
  })

  it('absorbs folders nested inside a newly added one, keeping their notes', async () => {
    await mkdir(join(dir, 'all/scifi'), { recursive: true })
    await writeFile(join(dir, 'all/scifi/Dune.epub'), 'PK')
    await writeFile(join(dir, 'all/Other.epub'), 'PK')

    const inner = library.addFolder(join(dir, 'all/scifi'))!
    await library.scan(inner.id)
    const [dune] = store.listBooks()
    store.setProgress(dune.id, 0.4, 'loc')

    const outer = library.addFolder(join(dir, 'all'))!
    await library.scan(outer.id)
    expect(library.listFolders().map(folder => folder.path)).toEqual([join(dir, 'all')])
    const books = store.listBooks()
    expect(books.map(book => book.title).sort()).toEqual(['Dune', 'Other'])
    expect(books.find(book => book.title === 'Dune')).toMatchObject({ id: dune.id, progress: 0.4 })

    // and a path already covered is not added a second time
    expect(library.addFolder(join(dir, 'all/scifi'))!.id).toBe(outer.id)
    expect(library.listFolders()).toHaveLength(1)
  })

  it('is not led in circles by a symlink to a parent directory', async () => {
    await mkdir(join(dir, 'loop/sub'), { recursive: true })
    await writeFile(join(dir, 'loop/sub/Book.epub'), 'PK')
    await symlink(join(dir, 'loop'), join(dir, 'loop/sub/up'))
    const books = await scanFolder(join(dir, 'loop'))
    expect(books.map(book => book.path)).toEqual([join(dir, 'loop/sub/Book.epub')])
  })

  it('survives pathological markup, and still finds the other books', async () => {
    const root = join(dir, 'odd')
    await mkdir(join(root, 'deep-site'), { recursive: true })
    const nest = (open: string, close: string, n: number) => open.repeat(n) + 'x' + close.repeat(n)
    // a heading buried under thousands of elements, and a navigation list nested hundreds deep
    await writeFile(join(root, 'Deep.html'), `<html><body><h1 id="a">${nest('<span>', '</span>', 20000)}</h1></body></html>`)
    await writeFile(
      join(root, 'deep-site/index.html'),
      `<html><head><meta name=generator <title>Deep</title></head><body><nav>${nest('<ul><li><a href="p.html">p</a>', '</li></ul>', 600)}</nav></body></html>`,
    )
    await writeFile(join(root, 'deep-site/p.html'), '<html><body><p>page</p></body></html>')
    await writeFile(join(root, 'Fine.epub'), 'PK')

    const started = Date.now()
    const books = await scanFolder(root)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(books.some(book => book.path.endsWith('Fine.epub'))).toBe(true)
    expect(books.some(book => book.path.endsWith('deep-site'))).toBe(true)
  })
})

describe('move detection', () => {
  it('does not hand a returning file\'s row to a newcomer with the same name', () => {
    const folder = store.addFolder('/lib')
    const book = (path: string) => ({ path, format: 'epub' as const, title: 'Book', size: 500, mtime: 1 })
    store.syncFolder(folder, [book('/lib/z/book.epub')])
    const [original] = store.listBooks()
    store.setProgress(original.id, 0.7, 'loc')
    store.syncFolder(folder, [])

    store.syncFolder(folder, [book('/lib/a/book.epub'), book('/lib/z/book.epub')])
    const books = store.listBooks()
    expect(books).toHaveLength(2)
    expect(books.find(b => b.path === '/lib/z/book.epub')).toMatchObject({ id: original.id, progress: 0.7 })
    expect(books.find(b => b.path === '/lib/a/book.epub')!.progress).toBe(0)
  })

  it('matches the file name exactly', () => {
    const folder = store.addFolder('/lib')
    store.syncFolder(folder, [{ path: '/lib/Book.epub', format: 'epub', title: 'Book', size: 500, mtime: 1 }])
    const [original] = store.listBooks()
    store.syncFolder(folder, [{ path: '/lib/x/BOOK.epub', format: 'epub', title: 'BOOK', size: 500, mtime: 1 }])
    const [other] = store.listBooks()
    expect(other.id).not.toBe(original.id)
  })
})

describe('download names', () => {
  it('takes the extension from the headers or the URL, never an unknown one', () => {
    expect(downloadExtension('application/epub+zip', null, '/ebooks/2701.epub3.images')).toBe('.epub')
    expect(downloadExtension('application/octet-stream', 'attachment; filename="moby.mobi"', '/get')).toBe('.mobi')
    expect(downloadExtension('application/zip', null, '/files/book.fb2.zip')).toBe('.fb2.zip')
    expect(downloadExtension('application/zip', null, '/files/archive.zip')).toBe('.epub')
    expect(downloadExtension('application/pdf', null, '/files/100%.pdf')).toBe('.pdf')
  })
})
