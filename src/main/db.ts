import { basename } from 'node:path'
import Database from 'better-sqlite3'
import {
  DEFAULT_SETTINGS,
  WEB_MANIFEST_VERSION,
  type Annotation,
  type Book,
  type BookFormat,
  type BookMeta,
  type Bookmark,
  type Folder,
  type MetaState,
  type NewAnnotation,
  type NewBookmark,
  type OpdsCatalog,
  type Settings,
  type WebBookManifest,
} from '@shared/types'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    added_at INTEGER NOT NULL
  );
  CREATE TABLE books (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    format TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT '',
    publisher TEXT NOT NULL DEFAULT '',
    published TEXT NOT NULL DEFAULT '',
    identifier TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    last_opened_at INTEGER,
    progress REAL NOT NULL DEFAULT 0,
    location TEXT,
    cover_version INTEGER NOT NULL DEFAULT 0,
    meta_state TEXT NOT NULL DEFAULT 'pending',
    missing INTEGER NOT NULL DEFAULT 0,
    manifest TEXT
  );
  CREATE INDEX books_folder ON books(folder_id);
  CREATE TABLE annotations (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    selector TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'yellow',
    style TEXT NOT NULL DEFAULT 'highlight',
    label TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX annotations_book ON annotations(book_id);
  CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    location TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    excerpt TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX bookmarks_book ON bookmarks(book_id);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // A book the reader took out of the library: its row (and notes) stay, so
  // that the next scan does not simply add the file again.
  `ALTER TABLE books ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;`,
  // Covers are now also looked for beyond the file's own metadata: give the
  // books that have none another go.
  `UPDATE books SET meta_state = 'pending' WHERE cover_version = 0 AND format <> 'web';`,
]

interface BookRow {
  id: number
  folder_id: number
  path: string
  format: string
  title: string
  author: string
  description: string
  language: string
  publisher: string
  published: string
  identifier: string
  size: number
  mtime: number
  added_at: number
  last_opened_at: number | null
  progress: number
  location: string | null
  cover_version: number
  meta_state: string
  missing: number
}

interface AnnotationRow {
  id: number
  book_id: number
  selector: string
  text: string
  note: string
  color: string
  style: string
  label: string
  position: number
  created_at: number
  updated_at: number
}

interface BookmarkRow {
  id: number
  book_id: number
  location: string
  label: string
  excerpt: string
  position: number
  created_at: number
}

const BOOK_COLUMNS = `id, folder_id, path, format, title, author, description, language,
  publisher, published, identifier, size, mtime, added_at, last_opened_at, progress,
  location, cover_version, meta_state, missing`

const toBook = (row: BookRow): Book => ({
  id: row.id,
  folderId: row.folder_id,
  path: row.path,
  format: row.format as BookFormat,
  title: row.title,
  author: row.author,
  description: row.description,
  language: row.language,
  publisher: row.publisher,
  published: row.published,
  identifier: row.identifier,
  size: row.size,
  mtime: row.mtime,
  addedAt: row.added_at,
  lastOpenedAt: row.last_opened_at,
  progress: row.progress,
  location: row.location,
  coverVersion: row.cover_version,
  metaState: row.meta_state as MetaState,
  missing: !!row.missing,
})

const toAnnotation = (row: AnnotationRow): Annotation => ({
  id: row.id,
  bookId: row.book_id,
  selector: JSON.parse(row.selector),
  text: row.text,
  note: row.note,
  color: row.color as Annotation['color'],
  style: row.style as Annotation['style'],
  label: row.label,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toBookmark = (row: BookmarkRow): Bookmark => ({
  id: row.id,
  bookId: row.book_id,
  location: row.location,
  label: row.label,
  excerpt: row.excerpt,
  position: row.position,
  createdAt: row.created_at,
})

/** A file or web-book root discovered by the scanner. */
export interface ScannedBook {
  path: string
  format: BookFormat
  title: string
  size: number
  mtime: number
  manifest?: WebBookManifest
}

export class Store {
  readonly db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i])
        this.db.pragma(`user_version = ${i + 1}`)
      })()
    }
  }

  close(): void {
    this.db.close()
  }

  /* ---------- folders ---------- */

  listFolders(): Omit<Folder, 'missing'>[] {
    return this.db
      .prepare(
        `SELECT f.id, f.path, f.added_at AS addedAt,
           (SELECT count(*) FROM books b WHERE b.folder_id = f.id AND b.missing = 0 AND b.hidden = 0) AS bookCount
         FROM folders f ORDER BY f.path`,
      )
      .all() as Omit<Folder, 'missing'>[]
  }

  getFolder(id: number): Omit<Folder, 'missing'> | null {
    return this.listFolders().find(f => f.id === id) ?? null
  }

  addFolder(path: string): number {
    const existing = this.db.prepare('SELECT id FROM folders WHERE path = ?').get(path) as
      | { id: number }
      | undefined
    if (existing) return existing.id
    const info = this.db
      .prepare('INSERT INTO folders (path, added_at) VALUES (?, ?)')
      .run(path, Date.now())
    return Number(info.lastInsertRowid)
  }

  removeFolder(id: number): void {
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
  }

  /** Hands a folder's books (with their notes) to another folder and drops it. */
  mergeFolder(from: number, into: number): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE books SET folder_id = ? WHERE folder_id = ?').run(into, from)
      this.db.prepare('DELETE FROM folders WHERE id = ?').run(from)
    })()
  }

  /* ---------- books ---------- */

  listBooks(): Book[] {
    const rows = this.db
      .prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE missing = 0 AND hidden = 0`)
      .all() as BookRow[]
    return rows.map(toBook)
  }

  getBook(id: number): Book | null {
    const row = this.db.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = ?`).get(id) as
      | BookRow
      | undefined
    return row ? toBook(row) : null
  }

  getManifest(id: number): WebBookManifest | null {
    const row = this.db.prepare('SELECT manifest FROM books WHERE id = ?').get(id) as
      | { manifest: string | null }
      | undefined
    return row?.manifest ? JSON.parse(row.manifest) : null
  }

  /** Size and mtime of a folder's web books, for the scanner to compare against. */
  knownWebBooks(folderId: number): Map<string, { mtime: number; size: number }> {
    const rows = this.db
      .prepare(
        `SELECT path, size, mtime FROM books
         WHERE folder_id = ? AND format = 'web' AND missing = 0
           AND json_extract(manifest, '$.version') = ?`,
      )
      .all(folderId, WEB_MANIFEST_VERSION) as { path: string; size: number; mtime: number }[]
    return new Map(rows.map(row => [row.path, { mtime: row.mtime, size: row.size }]))
  }

  /**
   * Reconciles a folder's rows with what the scanner found on disk. New files
   * are inserted, changed ones are queued for metadata extraction again, and
   * rows whose file disappeared are kept (hidden) so that their annotations
   * survive the file coming back or being moved.
   */
  syncFolder(folderId: number, scanned: ScannedBook[]): { added: number; removed: number } {
    const existing = this.db
      .prepare('SELECT id, path, format, size, mtime, missing FROM books WHERE folder_id = ?')
      .all(folderId) as Pick<BookRow, 'id' | 'path' | 'format' | 'size' | 'mtime' | 'missing'>[]
    const byPath = new Map(existing.map(row => [row.path, row]))
    const scannedPaths = new Set(scanned.map(item => item.path))
    let added = 0
    let removed = 0

    const insert = this.db.prepare(
      `INSERT INTO books (folder_id, path, format, title, size, mtime, added_at, manifest, meta_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    const touch = this.db.prepare(
      `UPDATE books SET size = ?, mtime = ?, format = ?, manifest = coalesce(?, manifest),
         missing = 0, meta_state = 'pending'
       WHERE id = ?`,
    )
    const revive = this.db.prepare('UPDATE books SET missing = 0 WHERE id = ?')
    const move = this.db.prepare(
      'UPDATE books SET path = ?, folder_id = ?, mtime = ?, manifest = ?, missing = 0 WHERE id = ?',
    )
    const markMissing = this.db.prepare('UPDATE books SET missing = 1 WHERE id = ?')
    // A book that vanished from one path and shows up at another with the
    // same name and size was most likely moved; keep its row (and notes).
    const findMoved = this.db.prepare(
      `SELECT id, path FROM books
       WHERE missing = 1 AND format = ? AND size = ? AND path LIKE ? ESCAPE '\\'`,
    )

    this.db.transaction(() => {
      // Mark the vanished ones first so that the move detection below can
      // also pair up files that were moved within this folder.
      for (const row of existing) {
        if (!scannedPaths.has(row.path) && !row.missing) {
          markMissing.run(row.id)
          removed++
        }
      }
      // Then everything we already have a row for, so that a file which is
      // simply back is never mistaken for the old home of a moved one.
      const fresh: ScannedBook[] = []
      for (const item of scanned) {
        const row = byPath.get(item.path)
        if (!row) {
          fresh.push(item)
          continue
        }
        const manifest = item.manifest ? JSON.stringify(item.manifest) : null
        // A fresh manifest means the scanner re-read the book: store it even
        // when the files look the same as before.
        if (
          manifest ||
          row.size !== item.size ||
          row.mtime !== item.mtime ||
          row.format !== item.format
        )
          touch.run(item.size, item.mtime, item.format, manifest, row.id)
        else if (row.missing) revive.run(row.id)
      }
      for (const item of fresh) {
        const manifest = item.manifest ? JSON.stringify(item.manifest) : null
        const name = basename(item.path)
        const pattern = '%/' + name.replace(/[\\%_]/g, c => '\\' + c)
        // LIKE ignores ASCII case; insist on the exact name.
        const moved =
          item.format === 'web'
            ? undefined
            : (findMoved.all(item.format, item.size, pattern) as { id: number; path: string }[]).find(
                candidate => basename(candidate.path) === name && !scannedPaths.has(candidate.path),
              )
        if (moved) move.run(item.path, folderId, item.mtime, manifest, moved.id)
        else
          insert.run(
            folderId,
            item.path,
            item.format,
            item.title,
            item.size,
            item.mtime,
            Date.now(),
            manifest,
          )
        added++
      }
    })()
    return { added, removed }
  }

  setMeta(id: number, meta: BookMeta | null, coverChanged: boolean): void {
    const book = this.getBook(id)
    if (!book) return
    const clean = (value: string | undefined, fallback: string) =>
      typeof value === 'string' && value.trim() ? value.trim() : fallback
    this.db
      .prepare(
        `UPDATE books SET title = ?, author = ?, description = ?, language = ?, publisher = ?,
           published = ?, identifier = ?, meta_state = ?,
           cover_version = CASE WHEN ? THEN ? ELSE cover_version END
         WHERE id = ?`,
      )
      .run(
        clean(meta?.title, book.title),
        clean(meta?.author, book.author),
        clean(meta?.description, book.description),
        clean(meta?.language, book.language),
        clean(meta?.publisher, book.publisher),
        clean(meta?.published, book.published),
        clean(meta?.identifier, book.identifier),
        meta ? 'done' : 'failed',
        coverChanged ? 1 : 0,
        Date.now(),
        id,
      )
  }

  setProgress(id: number, progress: number, location: string): void {
    const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
    this.db
      .prepare('UPDATE books SET progress = ?, location = ? WHERE id = ?')
      .run(clamped, location, id)
  }

  markOpened(id: number): void {
    this.db.prepare('UPDATE books SET last_opened_at = ? WHERE id = ?').run(Date.now(), id)
  }

  getBookByPath(path: string): Book | null {
    const row = this.db.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE path = ?`).get(path) as
      | BookRow
      | undefined
    return row ? toBook(row) : null
  }

  /** Takes a book out of the library's list (or puts it back). Its notes are kept. */
  setHidden(id: number, hidden: boolean): void {
    this.db.prepare('UPDATE books SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id)
  }

  /** How many books that are still on disk have been taken out of the list. */
  countHidden(): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM books WHERE hidden = 1 AND missing = 0')
      .get() as { n: number }
    return row.n
  }

  restoreHidden(): void {
    this.db.prepare('UPDATE books SET hidden = 0 WHERE hidden = 1').run()
  }

  /** Every book of a folder, hidden and missing ones included. */
  bookIdsIn(folderId: number): number[] {
    const rows = this.db.prepare('SELECT id FROM books WHERE folder_id = ?').all(folderId) as { id: number }[]
    return rows.map(row => row.id)
  }

  /* ---------- annotations ---------- */

  listAnnotations(bookId: number): Annotation[] {
    const rows = this.db
      .prepare('SELECT * FROM annotations WHERE book_id = ? ORDER BY position, id')
      .all(bookId) as AnnotationRow[]
    return rows.map(toAnnotation)
  }

  getAnnotation(id: number): Annotation | null {
    const row = this.db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as
      | AnnotationRow
      | undefined
    return row ? toAnnotation(row) : null
  }

  addAnnotation(a: NewAnnotation): Annotation {
    const now = Date.now()
    const created = a.createdAt ?? now
    const info = this.db
      .prepare(
        `INSERT INTO annotations
           (book_id, selector, text, note, color, style, label, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.bookId,
        JSON.stringify(a.selector),
        a.text,
        a.note,
        a.color,
        a.style,
        a.label,
        a.position,
        created,
        now,
      )
    return this.getAnnotation(Number(info.lastInsertRowid))!
  }

  updateAnnotation(
    id: number,
    patch: Partial<Pick<Annotation, 'note' | 'color' | 'style' | 'selector'>>,
  ): Annotation | null {
    const current = this.getAnnotation(id)
    if (!current) return null
    this.db
      .prepare(
        'UPDATE annotations SET note = ?, color = ?, style = ?, selector = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        patch.note ?? current.note,
        patch.color ?? current.color,
        patch.style ?? current.style,
        JSON.stringify(patch.selector ?? current.selector),
        Date.now(),
        id,
      )
    return this.getAnnotation(id)
  }

  removeAnnotation(id: number): void {
    this.db.prepare('DELETE FROM annotations WHERE id = ?').run(id)
  }

  /* ---------- bookmarks ---------- */

  listBookmarks(bookId: number): Bookmark[] {
    const rows = this.db
      .prepare('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY position, id')
      .all(bookId) as BookmarkRow[]
    return rows.map(toBookmark)
  }

  addBookmark(b: NewBookmark): Bookmark {
    const info = this.db
      .prepare(
        `INSERT INTO bookmarks (book_id, location, label, excerpt, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(b.bookId, b.location, b.label, b.excerpt, b.position, b.createdAt ?? Date.now())
    const row = this.db
      .prepare('SELECT * FROM bookmarks WHERE id = ?')
      .get(info.lastInsertRowid) as BookmarkRow
    return toBookmark(row)
  }

  removeBookmark(id: number): void {
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
  }

  /* ---------- settings ---------- */

  private getValue<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  private setValue(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value))
  }

  getSettings(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.getValue<Partial<Settings>>('settings', {}) }
  }

  setSettings(patch: Partial<Settings>): Settings {
    const known = Object.fromEntries(
      Object.entries(patch).filter(([key]) => key in DEFAULT_SETTINGS),
    )
    const next = { ...this.getSettings(), ...known }
    this.setValue('settings', next)
    return next
  }

  getCatalogs(): OpdsCatalog[] {
    return this.getValue<OpdsCatalog[]>('opds', [])
  }

  setCatalogs(catalogs: OpdsCatalog[]): void {
    this.setValue('opds', catalogs)
  }

  getWindowState<T>(fallback: T): T {
    return this.getValue('window', fallback)
  }

  setWindowState(state: unknown): void {
    this.setValue('window', state)
  }
}
