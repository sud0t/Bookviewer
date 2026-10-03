import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store, type ScannedBook } from '../../src/main/db'
import { DEFAULT_SETTINGS, WEB_MANIFEST_VERSION, type Selector } from '../../src/shared/types'

let dir: string
let store: Store

const file = (path: string, size = 100, mtime = 1): ScannedBook => ({
  path,
  format: 'epub',
  title: path.split('/').pop()!,
  size,
  mtime,
})

const selector: Selector = {
  type: 'cfi',
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)',
  quote: { exact: 'Hello', prefix: '', suffix: ' world' },
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookviewer-db-'))
  store = new Store(join(dir, 'library.db'))
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('library sync', () => {
  it('adds new books and hides ones that disappear', () => {
    const folder = store.addFolder('/lib')
    expect(store.syncFolder(folder, [file('/lib/a.epub'), file('/lib/b.epub')])).toEqual({ added: 2, removed: 0 })
    expect(store.listBooks().map(b => b.path).sort()).toEqual(['/lib/a.epub', '/lib/b.epub'])
    expect(store.listFolders()[0].bookCount).toBe(2)

    expect(store.syncFolder(folder, [file('/lib/a.epub')])).toEqual({ added: 0, removed: 1 })
    expect(store.listBooks().map(b => b.path)).toEqual(['/lib/a.epub'])
  })

  it('keeps reading data when a file goes away and comes back', () => {
    const folder = store.addFolder('/lib')
    store.syncFolder(folder, [file('/lib/a.epub')])
    const [book] = store.listBooks()
    store.setProgress(book.id, 0.5, 'somewhere')
    store.addAnnotation({ bookId: book.id, selector, text: 'Hello', note: '', color: 'yellow', style: 'highlight', label: '', position: 0.1 })

    store.syncFolder(folder, [])
    expect(store.listBooks()).toHaveLength(0)
    store.syncFolder(folder, [file('/lib/a.epub')])
    const [back] = store.listBooks()
    expect(back.id).toBe(book.id)
    expect(back.progress).toBe(0.5)
    expect(store.listAnnotations(back.id)).toHaveLength(1)
  })

  it('follows a file that was moved or renamed into another folder', () => {
    const folder = store.addFolder('/lib')
    store.syncFolder(folder, [file('/lib/a.epub', 1234)])
    const [book] = store.listBooks()
    store.setProgress(book.id, 0.25, 'loc')

    store.syncFolder(folder, [file('/lib/sub/a.epub', 1234, 2)])
    const books = store.listBooks()
    expect(books).toHaveLength(1)
    expect(books[0].id).toBe(book.id)
    expect(books[0].path).toBe('/lib/sub/a.epub')
    expect(books[0].progress).toBe(0.25)
  })

  it('queues a changed file for metadata again', () => {
    const folder = store.addFolder('/lib')
    store.syncFolder(folder, [file('/lib/a.epub', 100, 1)])
    const [book] = store.listBooks()
    store.setMeta(book.id, { title: 'Real Title', author: 'Someone' }, false)
    expect(store.getBook(book.id)).toMatchObject({ title: 'Real Title', author: 'Someone', metaState: 'done' })

    store.syncFolder(folder, [file('/lib/a.epub', 100, 1)])
    expect(store.getBook(book.id)!.metaState).toBe('done')
    store.syncFolder(folder, [file('/lib/a.epub', 200, 5)])
    expect(store.getBook(book.id)).toMatchObject({ metaState: 'pending', size: 200, title: 'Real Title' })
  })

  it('stores web book manifests and remembers which are current', () => {
    const folder = store.addFolder('/lib')
    const manifest = {
      version: WEB_MANIFEST_VERSION,
      generator: 'mdbook' as const,
      title: 'Site',
      author: '',
      language: 'en',
      description: '',
      pages: [{ href: 'index.html', title: 'Home', size: 10 }],
      toc: [],
      cover: null,
    }
    store.syncFolder(folder, [{ path: '/lib/site', format: 'web', title: 'Site', size: 10, mtime: 7, manifest }])
    const [book] = store.listBooks()
    expect(store.getManifest(book.id)).toEqual(manifest)
    expect(store.knownWebBooks(folder).get('/lib/site')).toEqual({ mtime: 7, size: 10 })

    // an unchanged pass-through (no manifest) leaves the stored one alone
    store.syncFolder(folder, [{ path: '/lib/site', format: 'web', title: '', size: 10, mtime: 7 }])
    expect(store.getManifest(book.id)).toEqual(manifest)

    // a manifest written by an older scanner is not "known": it gets re-read
    store.db.prepare(`UPDATE books SET manifest = json_set(manifest, '$.version', 0)`).run()
    expect(store.knownWebBooks(folder).size).toBe(0)
  })

  it('removes a folder together with its books and their notes', () => {
    const folder = store.addFolder('/lib')
    store.syncFolder(folder, [file('/lib/a.epub')])
    const [book] = store.listBooks()
    store.addBookmark({ bookId: book.id, location: 'x', label: '', excerpt: '', position: 0 })
    store.removeFolder(folder)
    expect(store.listBooks()).toHaveLength(0)
    expect(store.listBookmarks(book.id)).toHaveLength(0)
  })
})

describe('annotations', () => {
  it('saves, updates, orders and deletes', () => {
    const folder = store.addFolder('/lib')
    store.syncFolder(folder, [file('/lib/a.epub')])
    const [book] = store.listBooks()
    const base = { bookId: book.id, selector, text: 'Hello', note: '', color: 'yellow' as const, style: 'highlight' as const, label: 'Ch 1' }
    const late = store.addAnnotation({ ...base, position: 0.9 })
    const early = store.addAnnotation({ ...base, position: 0.1 })
    expect(store.listAnnotations(book.id).map(a => a.id)).toEqual([early.id, late.id])
    expect(early.selector).toEqual(selector)

    const updated = store.updateAnnotation(early.id, { note: 'a note', color: 'blue' })!
    expect(updated).toMatchObject({ note: 'a note', color: 'blue', style: 'highlight' })
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt)

    store.removeAnnotation(late.id)
    expect(store.listAnnotations(book.id)).toHaveLength(1)
    expect(store.updateAnnotation(late.id, { note: 'x' })).toBeNull()
  })
})

describe('settings', () => {
  it('start from the defaults and keep only known keys', () => {
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    const next = store.setSettings({ fontSize: 22, bogus: true } as never)
    expect(next.fontSize).toBe(22)
    expect('bogus' in next).toBe(false)
    expect(store.getSettings().fontSize).toBe(22)
  })

  it('survive reopening the database', () => {
    store.setSettings({ theme: 'sepia', themeAuto: false })
    store.close()
    store = new Store(join(dir, 'library.db'))
    expect(store.getSettings()).toMatchObject({ theme: 'sepia', themeAuto: false })
  })

  it('clamps progress', () => {
    const folder = store.addFolder('/lib')
    store.syncFolder(folder, [file('/lib/a.epub')])
    const [book] = store.listBooks()
    store.setProgress(book.id, 7, 'x')
    expect(store.getBook(book.id)!.progress).toBe(1)
    store.setProgress(book.id, Number.NaN, 'x')
    expect(store.getBook(book.id)!.progress).toBe(0)
  })
})

describe('removing a single book', () => {
  it('keeps a removed book out of the list across scans, with its notes, until it is put back', () => {
    const folder = store.addFolder('/lib')
    store.syncFolder(folder, [file('/lib/a.epub'), file('/lib/b.epub')])
    const book = store.getBookByPath('/lib/a.epub')!
    store.addAnnotation({ bookId: book.id, selector, text: 'Hello', note: '', color: 'yellow', style: 'highlight', label: '', position: 0.1 })

    store.setHidden(book.id, true)
    expect(store.listBooks().map(b => b.path)).toEqual(['/lib/b.epub'])
    expect(store.listFolders()[0].bookCount).toBe(1)
    expect(store.countHidden()).toBe(1)

    // the next scan finds the file again: it must not come back by itself
    expect(store.syncFolder(folder, [file('/lib/a.epub', 200, 2), file('/lib/b.epub')])).toEqual({ added: 0, removed: 0 })
    expect(store.listBooks().map(b => b.path)).toEqual(['/lib/b.epub'])

    store.restoreHidden()
    expect(store.listBooks().map(b => b.path).sort()).toEqual(['/lib/a.epub', '/lib/b.epub'])
    expect(store.listAnnotations(book.id)).toHaveLength(1)
    expect(store.countHidden()).toBe(0)
  })
})
