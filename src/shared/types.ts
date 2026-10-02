export const EBOOK_EXTENSIONS = {
  epub: 'epub',
  mobi: 'mobi',
  azw: 'mobi',
  azw3: 'azw3',
  kf8: 'azw3',
  fb2: 'fb2',
  fbz: 'fbz',
  cbz: 'cbz',
  pdf: 'pdf',
} as const satisfies Record<string, BookFormat>

export type BookFormat = 'epub' | 'mobi' | 'azw3' | 'fb2' | 'fbz' | 'cbz' | 'pdf' | 'web'

export interface Folder {
  id: number
  path: string
  addedAt: number
  bookCount: number
  /** The directory no longer exists (unplugged drive, moved, ...). */
  missing: boolean
}

export type MetaState = 'pending' | 'done' | 'failed'

export interface Book {
  id: number
  folderId: number
  /** The book file, or for web books the root directory / single HTML file. */
  path: string
  format: BookFormat
  title: string
  author: string
  description: string
  language: string
  publisher: string
  published: string
  identifier: string
  size: number
  mtime: number
  addedAt: number
  lastOpenedAt: number | null
  /** Reading progress, 0..1. */
  progress: number
  /** Engine-specific location to restore (see `ReadingLocation`). */
  location: string | null
  /** Changes whenever the cached cover does; 0 when there is none. */
  coverVersion: number
  metaState: MetaState
  missing: boolean
}

export interface BookMeta {
  title?: string
  author?: string
  description?: string
  language?: string
  publisher?: string
  published?: string
  identifier?: string
}

/* ---------- web books ---------- */

export type WebGenerator =
  | 'mdbook'
  | 'sphinx'
  | 'mkdocs'
  | 'docusaurus'
  | 'gitbook'
  | 'generic'
  | 'single'

export interface TocNode {
  label: string
  /** Path relative to the book root, optionally with a `#fragment`. */
  href: string | null
  children: TocNode[]
}

export interface WebPage {
  /** Path relative to the book root, percent-decoded, `/` separated. */
  href: string
  title: string
  size: number
}

/** Bump when the scanner gets better at reading sites, so that books are re-read. */
export const WEB_MANIFEST_VERSION = 2

export interface WebBookManifest {
  version: number
  generator: WebGenerator
  title: string
  author: string
  language: string
  description: string
  /** Pages in reading order. */
  pages: WebPage[]
  toc: TocNode[]
  /** Root-relative path of an image to use as the cover, if one was found. */
  cover: string | null
}

/* ---------- annotations ---------- */

export interface TextQuote {
  exact: string
  prefix: string
  suffix: string
}

export interface TextPosition {
  start: number
  end: number
}

/** A rectangle in PDF user space: [x1, y1, x2, y2]. */
export type PdfRect = [number, number, number, number]

export type Selector =
  /** EPUB and the other formats rendered through foliate-js. */
  | { type: 'cfi'; cfi: string; quote: TextQuote }
  /** HTML books: the page, then where in its extracted content. */
  | { type: 'web'; href: string; cfi: string; quote: TextQuote; position: TextPosition }
  /** PDF: 1-based page number and the highlighted rectangles. */
  | { type: 'pdf'; page: number; rects: PdfRect[]; quote: TextQuote }

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]
export type HighlightStyle = 'highlight' | 'underline' | 'squiggly' | 'strikethrough'

export interface Annotation {
  id: number
  bookId: number
  selector: Selector
  /** The highlighted text. */
  text: string
  note: string
  color: HighlightColor
  style: HighlightStyle
  /** Chapter / section label where the annotation lives. */
  label: string
  /** Approximate position in the book (0..1), used for ordering. */
  position: number
  createdAt: number
  updatedAt: number
}

export type NewAnnotation = Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'> & {
  /** Only when putting back something that was removed: its original date. */
  createdAt?: number
}

export interface Bookmark {
  id: number
  bookId: number
  /** Same format as `Book.location`. */
  location: string
  label: string
  excerpt: string
  position: number
  createdAt: number
}

export type NewBookmark = Omit<Bookmark, 'id' | 'createdAt'> & { createdAt?: number }

/* ---------- settings ---------- */

export type ThemeName = 'light' | 'sepia' | 'gray' | 'dark' | 'black'
export type Flow = 'scrolled' | 'paginated'

export interface Settings {
  theme: ThemeName
  /** Follow the desktop light/dark preference instead of `theme`. */
  themeAuto: boolean
  flow: Flow
  fontFamily: string
  /** In px. */
  fontSize: number
  lineHeight: number
  /** Maximum width of the text column, in px. */
  maxWidth: number
  justify: boolean
  hyphenate: boolean
  /** Use the publisher's fonts and spacing instead of ours. */
  publisherStyles: boolean
  /** Typeset TeX formulas (\\( ... \\)) found in the text. */
  renderMath: boolean
  maxColumns: number
  pdfZoom: 'page-width' | 'page-fit' | 'auto' | number
  /** Recolor PDF pages to match the theme. */
  pdfThemed: boolean
  libraryView: 'grid' | 'list'
  librarySort: 'recent' | 'title' | 'author' | 'added' | 'progress'
  ttsEngine: 'system' | 'espeak' | 'piper'
  ttsVoice: string
  ttsRate: number
  piperPath: string
  piperModel: string
  lookupLanguage: string
  translateTarget: string
  sidebarWidth: number
  /** The library folder that catalog downloads are saved into; null until one has been chosen or used. */
  downloadFolderId?: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  themeAuto: true,
  flow: 'scrolled',
  fontFamily: 'serif',
  fontSize: 18,
  lineHeight: 1.6,
  maxWidth: 760,
  justify: false,
  hyphenate: true,
  publisherStyles: false,
  renderMath: true,
  maxColumns: 2,
  pdfZoom: 'auto',
  pdfThemed: true,
  libraryView: 'grid',
  librarySort: 'recent',
  ttsEngine: 'system',
  ttsVoice: '',
  ttsRate: 1,
  piperPath: 'piper',
  piperModel: '',
  lookupLanguage: 'en',
  translateTarget: 'en',
  sidebarWidth: 300,
  downloadFolderId: null,
}

/* ---------- lookup ---------- */

export interface WikipediaSummary {
  title: string
  description: string
  extract: string
  thumbnail: string | null
  url: string
}

export interface DictionaryEntry {
  word: string
  phonetic: string
  meanings: {
    partOfSpeech: string
    definitions: { definition: string; example: string }[]
  }[]
  source: string
}

export interface TtsVoice {
  id: string
  name: string
  language: string
}

export interface OpdsResponse {
  url: string
  contentType: string
  body: string
}

export interface OpdsCatalog {
  title: string
  url: string
}

/* ---------- IPC contract ---------- */

export interface ScanProgress {
  folderId: number
  scanning: boolean
  found: number
}

export type ExportFormat = 'markdown' | 'json'

/** Request/response channels, handled in the main process. */
export interface IpcHandlers {
  'folders:list'(): Folder[]
  /** Opens a directory picker; resolves to the new folders. */
  'folders:add'(): Folder[]
  'folders:addPath'(path: string): Folder | null
  'folders:remove'(id: number): void
  'folders:rescan'(id?: number): void

  'books:list'(): Book[]
  'books:get'(id: number): Book | null
  'books:setMeta'(id: number, meta: BookMeta | null, cover: Uint8Array | null): void
  'books:setProgress'(id: number, progress: number, location: string): void
  'books:opened'(id: number): void
  'books:manifest'(id: number): WebBookManifest | null
  'books:showInFolder'(id: number): void
  'books:forget'(id: number): void

  'annotations:list'(bookId: number): Annotation[]
  'annotations:add'(annotation: NewAnnotation): Annotation
  'annotations:update'(
    id: number,
    patch: Partial<Pick<Annotation, 'note' | 'color' | 'style' | 'selector'>>,
  ): Annotation | null
  'annotations:remove'(id: number): void
  /** Opens a save dialog; resolves to the written path, or null if cancelled. */
  'annotations:export'(bookId: number, format: ExportFormat, content: string): string | null

  'bookmarks:list'(bookId: number): Bookmark[]
  'bookmarks:add'(bookmark: NewBookmark): Bookmark
  'bookmarks:remove'(id: number): void

  'settings:get'(): Settings
  'settings:set'(patch: Partial<Settings>): Settings

  'lookup:wikipedia'(query: string, language: string): WikipediaSummary | null
  'lookup:dictionary'(query: string, language: string): DictionaryEntry[]

  'tts:voices'(engine: 'espeak' | 'piper'): TtsVoice[]
  /** Synthesizes speech to a WAV file's bytes. */
  'tts:speak'(
    engine: 'espeak' | 'piper',
    text: string,
    opts: { voice: string; rate: number },
  ): Uint8Array

  'opds:catalogs'(): OpdsCatalog[]
  'opds:setCatalogs'(catalogs: OpdsCatalog[]): void
  'opds:fetch'(url: string): OpdsResponse
  /** A cover image from a catalog (fetched by the main process; pages may not load remote images). */
  'opds:image'(url: string): { type: string; bytes: Uint8Array } | null
  /** Downloads into a library folder; resolves to the saved path. */
  'opds:download'(url: string, folderId: number, suggestedName: string): string

  'shell:openExternal'(url: string): void
  'window:setFullscreen'(on: boolean): void
  'window:setTitle'(title: string): void
}

/** One-way notifications from the main process. */
export interface IpcEvents {
  'library:changed': undefined
  'scan:progress': ScanProgress
  'window:fullscreen': boolean
}

export type IpcChannel = keyof IpcHandlers
export type IpcEvent = keyof IpcEvents

export interface Bridge {
  invoke<K extends IpcChannel>(
    channel: K,
    ...args: Parameters<IpcHandlers[K]>
  ): Promise<ReturnType<IpcHandlers[K]>>
  on<K extends IpcEvent>(event: K, listener: (payload: IpcEvents[K]) => void): () => void
}

/** URL of a book's content under the `book://` protocol. */
export function bookUrl(id: number, path = ''): string {
  const encoded = path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  return `book://b${id}/${encoded}`
}

export function coverUrl(book: Pick<Book, 'id' | 'coverVersion'>): string | null {
  return book.coverVersion ? `book://cover/${book.id}?v=${book.coverVersion}` : null
}
