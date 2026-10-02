import { realpath, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { EBOOK_EXTENSIONS, type BookFormat, type Folder, type ScanProgress } from '@shared/types'
import type { ScannedBook, Store } from './db'
import {
  HTML_FILE,
  buildSinglePage,
  buildWebBook,
  classifyDir,
  listDir,
  type Classification,
  type DirListing,
} from './webbook'

const MAX_DEPTH = 10
/** How far below a plain "has an index.html" directory to look for real book roots. */
const NESTED_ROOT_DEPTH = 3

export function formatOf(name: string): BookFormat | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.fb2.zip')) return 'fbz'
  const ext = extname(lower).slice(1)
  return (EBOOK_EXTENSIONS as Record<string, BookFormat>)[ext] ?? null
}

const titleFromName = (name: string): string =>
  name
    .replace(/\.fb2\.zip$/i, '')
    .replace(/\.[^.]+$/, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || name

/** What the database already knows about a web book: enough to skip re-reading it. */
export type KnownWebBooks = Map<string, { mtime: number; size: number }>

/**
 * Walks a library folder and returns every book in it. Working out an HTML
 * book's page order means reading its pages, so those in `known` whose
 * files have not changed are passed through without a fresh manifest.
 */
export async function scanFolder(
  root: string,
  known: KnownWebBooks = new Map(),
): Promise<ScannedBook[]> {
  const books: ScannedBook[] = []
  const cache = new Map<string, { listing: DirListing; cls: Classification }>()

  const inspect = async (dir: string) => {
    let entry = cache.get(dir)
    if (!entry) {
      const listing = await listDir(dir)
      entry = { listing, cls: await classifyDir(dir, listing) }
      cache.set(dir, entry)
    }
    return entry
  }

  const hasNestedRoot = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > NESTED_ROOT_DEPTH) return false
    const { listing } = await inspect(dir)
    for (const name of listing.dirs) {
      const child = join(dir, name)
      const { cls } = await inspect(child)
      if (cls.generator) return true
      if (await hasNestedRoot(child, depth + 1)) return true
    }
    return false
  }

  const addWebRoot = async (dir: string, cls: Classification) => {
    // A directory's own mtime misses edits to files inside it, so fold in
    // the entry page's as well.
    const times = await Promise.all(
      [dir, join(dir, cls.entry!)].map(path =>
        stat(path).then(
          info => info.mtimeMs,
          () => 0,
        ),
      ),
    )
    const mtime = Math.round(Math.max(...times))
    const previous = known.get(dir)
    if (previous?.mtime === mtime) {
      books.push({ path: dir, format: 'web', title: '', size: previous.size, mtime })
      return
    }
    let manifest
    try {
      manifest = await buildWebBook(dir, cls.generator ?? 'generic', cls.entry!)
    } catch (error) {
      // One unreadable site must not keep the rest of the folder out.
      console.warn(`Could not read the HTML book in ${dir}:`, error)
      return
    }
    if (!manifest.pages.length) return
    books.push({
      path: dir,
      format: 'web',
      title: manifest.title,
      size: manifest.pages.reduce((sum, page) => sum + page.size, 0),
      mtime,
      manifest,
    })
  }

  // Directories already walked, by real path: a symlink back up the tree
  // would otherwise be followed again and again.
  const visited = new Set<string>()

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    const real = await realpath(dir).catch(() => dir)
    if (visited.has(real)) return
    visited.add(real)
    const { listing, cls } = await inspect(dir)
    const isRoot = depth === 0

    if (cls.generator) return addWebRoot(dir, cls)
    if (cls.candidate && !isRoot && cls.entry && !(await hasNestedRoot(dir, 1)))
      return addWebRoot(dir, cls)

    // From here on `dir` is a container of books. If it is itself a site
    // (has an index page) its loose pages belong to that site, not to us.
    const looseHtmlAreBooks = !listing.files.some(name => /^index\.x?html?$/i.test(name))
    for (const name of listing.files) {
      const path = join(dir, name)
      const format = formatOf(name)
      const isHtml = !format && HTML_FILE.test(name) && looseHtmlAreBooks
      if (!format && !isHtml) continue
      let info
      try {
        info = await stat(path)
      } catch {
        continue
      }
      if (format) {
        books.push({
          path,
          format,
          title: titleFromName(name),
          size: info.size,
          mtime: Math.round(info.mtimeMs),
        })
      } else {
        const mtime = Math.round(info.mtimeMs)
        const previous = known.get(path)
        if (previous?.mtime === mtime && previous.size === info.size) {
          books.push({ path, format: 'web', title: '', size: info.size, mtime })
          continue
        }
        try {
          const manifest = await buildSinglePage(path)
          books.push({ path, format: 'web', title: manifest.title, size: info.size, mtime, manifest })
        } catch (error) {
          console.warn(`Could not read ${path}:`, error)
        }
      }
    }
    for (const name of listing.dirs) {
      // Browsers save a page's resources next to it in "<name>_files".
      const saved = /^(.*)_files$/.exec(name)?.[1]
      if (saved && listing.files.some(file => file.replace(HTML_FILE, '') === saved)) continue
      await walk(join(dir, name), depth + 1)
    }
  }

  await walk(root, 0)
  return books
}

export class Library {
  private watchers = new Map<number, FSWatcher>()
  private timers = new Map<number, NodeJS.Timeout>()
  private scanning = new Map<number, Promise<void>>()
  private rescanQueued = new Set<number>()
  private stopped = false

  constructor(
    private store: Store,
    private notify: {
      changed(): void
      progress(progress: ScanProgress): void
    },
  ) {}

  listFolders(): Folder[] {
    return this.store.listFolders().map(folder => ({ ...folder, missing: !existsSync(folder.path) }))
  }

  async start(): Promise<void> {
    for (const folder of this.store.listFolders()) {
      this.watch(folder.id, folder.path)
      void this.scan(folder.id)
    }
  }

  /** Stops watching and lets scans in flight wind down without touching the database. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    await Promise.all([...this.watchers.values()].map(watcher => watcher.close()))
    this.watchers.clear()
    await Promise.allSettled([...this.scanning.values()])
  }

  /**
   * Adds a folder to the library. Folders may not overlap (a book has one
   * home): a path inside an existing folder is already covered, and adding
   * the parent of existing folders absorbs them, keeping their books' notes.
   */
  addFolder(path: string): Folder | null {
    const absolute = resolve(path)
    if (!existsSync(absolute)) return null
    const folders = this.store.listFolders()
    const within = (child: string, parent: string) =>
      child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
    const covering = folders.find(folder => within(absolute, folder.path))
    if (covering) {
      void this.scan(covering.id)
      return this.listFolders().find(folder => folder.id === covering.id) ?? null
    }
    const id = this.store.addFolder(absolute)
    for (const folder of folders) {
      if (!within(folder.path, absolute)) continue
      void this.watchers.get(folder.id)?.close()
      this.watchers.delete(folder.id)
      clearTimeout(this.timers.get(folder.id))
      this.store.mergeFolder(folder.id, id)
    }
    if (!this.watchers.has(id)) this.watch(id, absolute)
    void this.scan(id)
    this.notify.changed()
    return this.listFolders().find(folder => folder.id === id) ?? null
  }

  async removeFolder(id: number): Promise<void> {
    await this.watchers.get(id)?.close()
    this.watchers.delete(id)
    clearTimeout(this.timers.get(id))
    this.store.removeFolder(id)
    this.notify.changed()
  }

  async rescan(id?: number): Promise<void> {
    const ids = id == null ? this.store.listFolders().map(folder => folder.id) : [id]
    await Promise.all(ids.map(folderId => this.scan(folderId)))
  }

  /** Scans a folder; overlapping requests collapse into one follow-up scan. */
  scan(id: number): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const running = this.scanning.get(id)
    if (running) {
      this.rescanQueued.add(id)
      return running
    }
    // The bookkeeping happens in `finally`, which runs after `set` below
    // even when the scan itself had nothing to wait for.
    const run = this.runScan(id).finally(() => {
      this.scanning.delete(id)
      if (this.stopped) return
      if (this.rescanQueued.delete(id) && this.store.getFolder(id)) void this.scan(id)
    })
    this.scanning.set(id, run)
    return run
  }

  private async runScan(id: number): Promise<void> {
    const folder = this.store.getFolder(id)
    if (!folder) return
    this.notify.progress({ folderId: id, scanning: true, found: 0 })
    let found = 0
    try {
      if (existsSync(folder.path)) {
        const books = await scanFolder(folder.path, this.store.knownWebBooks(id))
        found = books.length
        if (this.stopped) return
        // The folder may have been removed (and its id even reused) while
        // we were walking it.
        if (this.store.getFolder(id)?.path === folder.path) this.store.syncFolder(id, books)
      }
    } catch (error) {
      console.error(`Scanning ${folder.path} failed:`, error)
    } finally {
      if (!this.stopped) {
        this.notify.progress({ folderId: id, scanning: false, found })
        this.notify.changed()
      }
    }
  }

  private watch(id: number, path: string): void {
    // Only directory structure and book files matter; watching every asset
    // of every saved site would burn through inotify watches for nothing.
    const watcher = watch(path, {
      ignoreInitial: true,
      depth: 4,
      ignored: (file, stats) => {
        const name = file.slice(file.lastIndexOf('/') + 1)
        if (name.startsWith('.') && file !== path) return true
        if (name === 'node_modules') return true
        if (stats?.isFile()) return !formatOf(name) && !HTML_FILE.test(name)
        return false
      },
    })
    const schedule = () => {
      clearTimeout(this.timers.get(id))
      this.timers.set(
        id,
        setTimeout(() => void this.scan(id), 1500),
      )
    }
    watcher.on('add', schedule).on('unlink', schedule).on('change', schedule)
    watcher.on('addDir', schedule).on('unlinkDir', schedule)
    watcher.on('error', error => console.warn(`Watching ${path} failed:`, error))
    this.watchers.set(id, watcher)
  }
}
