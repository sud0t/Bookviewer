/** Minimal typings for the parts of foliate-js (vendor/foliate-js) that we use. */

declare module 'foliate-js/types' {
  export type Anchor = (doc: Document) => Range | Element | null | number

  export interface Resolved {
    index: number
    anchor?: Anchor | number
  }

  export interface FoliateSection {
    id: unknown
    load(): string | Promise<string>
    unload?(): void
    createDocument?(): Document | Promise<Document>
    size: number
    linear?: string
    cfi?: string
    resolveHref?(href: string): string
    mediaOverlay?: unknown
  }

  export interface FoliateTocItem {
    id?: number
    label: string
    href?: string | null
    subitems?: FoliateTocItem[] | null
  }

  type Localized = string | Record<string, string>
  type Contributor = Localized | { name?: Localized; sortAs?: Localized }

  export interface FoliateMetadata {
    title?: Localized
    subtitle?: Localized
    author?: Contributor | Contributor[]
    language?: string | string[]
    description?: string
    publisher?: Contributor | Contributor[]
    published?: string
    identifier?: string
  }

  export interface FoliateBook {
    sections: FoliateSection[]
    dir?: 'ltr' | 'rtl'
    toc?: FoliateTocItem[] | null
    pageList?: FoliateTocItem[] | null
    landmarks?: { type: string[]; href: string }[] | null
    metadata?: FoliateMetadata
    rendition?: { layout?: string; spread?: string; viewport?: unknown }
    transformTarget?: EventTarget
    resolveHref(href: string): Resolved | null | undefined
    resolveCFI?(cfi: string): Resolved
    isExternal?(href: string): boolean
    splitTOCHref?(href: string): unknown[] | Promise<unknown[]>
    getTOCFragment?(doc: Document, id: unknown): Node | null
    getCover?(): Blob | null | Promise<Blob | null>
    /** (EPUB) Reads a file of the book by its path inside the archive. */
    loadText?(name: string): Promise<string> | null
    loadBlob?(name: string, type?: string): Promise<Blob> | null
    destroy?(): void
  }

  export interface ZipLoader {
    entries: { filename: string }[]
    loadText(name: string): Promise<string> | null
    loadBlob(name: string, type?: string): Promise<Blob> | null
    getSize(name: string): number
  }

  /** What the format modules need from a file: lazily readable byte ranges. */
  export interface FileLike {
    readonly name: string
    readonly size: number
    readonly type: string
    slice(start?: number, end?: number, contentType?: string): { arrayBuffer(): Promise<ArrayBuffer> }
    arrayBuffer(): Promise<ArrayBuffer>
  }
}

declare module 'foliate-js/epub.js' {
  import type { FoliateBook, ZipLoader } from 'foliate-js/types'
  export class EPUB {
    constructor(loader: Omit<ZipLoader, 'entries'> & { sha1?: unknown })
    init(): Promise<FoliateBook>
  }
}

declare module 'foliate-js/mobi.js' {
  import type { FileLike, FoliateBook } from 'foliate-js/types'
  export function isMOBI(file: FileLike): Promise<boolean>
  export class MOBI {
    constructor(opts: { unzlib: (data: Uint8Array) => Uint8Array })
    open(file: FileLike): Promise<FoliateBook>
  }
}

declare module 'foliate-js/fb2.js' {
  import type { FoliateBook } from 'foliate-js/types'
  export function makeFB2(blob: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<FoliateBook>
}

declare module 'foliate-js/comic-book.js' {
  import type { FoliateBook, ZipLoader } from 'foliate-js/types'
  export function makeComicBook(loader: ZipLoader, file: { name: string }): FoliateBook
}

declare module 'foliate-js/vendor/zip.js' {
  export function configure(options: { useWebWorkers?: boolean }): void
  export class BlobReader {
    constructor(blob: unknown)
  }
  export class TextWriter {
    private text: true
  }
  export class BlobWriter {
    private blob: true
    constructor(type?: string)
  }
  export interface ZipEntry {
    filename: string
    uncompressedSize: number
    directory: boolean
    getData(writer: TextWriter): Promise<string>
    getData(writer: BlobWriter): Promise<Blob>
  }
  export class ZipReader {
    constructor(reader: BlobReader)
    getEntries(): Promise<ZipEntry[]>
  }
}

declare module 'foliate-js/vendor/fflate.js' {
  export function unzlibSync(data: Uint8Array): Uint8Array
}

declare module 'foliate-js/epubcfi.js' {
  export type CFIPart = { index: number; id?: string; offset?: number }
  export type ParsedCFI = CFIPart[][] | { parent: CFIPart[][]; start: CFIPart[][]; end: CFIPart[][] }
  export const isCFI: RegExp
  export function joinIndir(...cfis: string[]): string
  export function parse(cfi: string): ParsedCFI
  export function collapse(cfi: string | ParsedCFI, toEnd?: boolean): string | CFIPart[][]
  export function compare(a: string, b: string): number
  export function fromRange(range: Range, filter?: (node: Node) => number): string
  export function toRange(doc: Document, parts: ParsedCFI, filter?: (node: Node) => number): Range
  export const fake: {
    fromIndex(index: number): string
    toIndex(parts: CFIPart[] | undefined): number
  }
}

declare module 'foliate-js/progress.js' {
  import type { FoliateSection, FoliateTocItem } from 'foliate-js/types'
  export class TOCProgress {
    init(opts: {
      toc: FoliateTocItem[]
      ids: unknown[]
      splitHref(href: string): unknown[] | Promise<unknown[]>
      getFragment(doc: Document, id: unknown): Node | null
    }): Promise<void>
    getProgress(index: number, range?: Range | null): FoliateTocItem | null | undefined
  }
  export interface SectionProgressInfo {
    fraction: number
    section: { current: number; total: number }
    location: { current: number; next: number; total: number }
    time: { section: number; total: number }
  }
  export class SectionProgress {
    constructor(sections: FoliateSection[], sizePerLoc: number, sizePerTimeUnit: number)
    sizes: number[]
    sizeTotal: number
    sectionFractions: number[]
    getProgress(index: number, fractionInSection: number, pageFraction?: number): SectionProgressInfo
    getSection(fraction: number): [number, number]
  }
}

declare module 'foliate-js/overlayer.js' {
  export type DrawFunction = (rects: DOMRectList | DOMRect[], options?: Record<string, unknown>) => SVGElement
  export class Overlayer {
    readonly element: SVGElement
    add(key: string, range: Range | ((root: Node) => Range), draw: DrawFunction, options?: Record<string, unknown>): void
    remove(key: string): void
    redraw(): void
    hitTest(point: { x: number; y: number }): [string, Range] | []
    static underline: DrawFunction
    static strikethrough: DrawFunction
    static squiggly: DrawFunction
    static highlight: DrawFunction
    static outline: DrawFunction
  }
}

declare module 'foliate-js/text-walker.js' {
  export type MakeRange = (startIndex: number, startOffset: number, endIndex: number, endOffset: number) => Range
  export function textWalker<T>(
    root: Document | DocumentFragment | Range,
    func: (strs: string[], makeRange: MakeRange) => Iterable<T>,
    filter?: (node: Node) => number,
  ): Generator<T>
}

declare module 'foliate-js/search.js' {
  import type { textWalker } from 'foliate-js/text-walker.js'
  export interface SearchExcerpt {
    pre: string
    match: string
    post: string
  }
  export function searchMatcher(
    walker: typeof textWalker,
    opts: {
      defaultLocale?: string
      matchCase?: boolean
      matchDiacritics?: boolean
      matchWholeWords?: boolean
      acceptNode?: (node: Node) => number
    },
  ): (doc: Document, query: string) => Generator<{ range: Range; excerpt: SearchExcerpt }>
}

declare module 'foliate-js/paginator.js' {
  export class Paginator extends HTMLElement {}
}

declare module 'foliate-js/fixed-layout.js' {
  export class FixedLayout extends HTMLElement {}
}

declare module 'foliate-js/opds.js' {
  export const REL: Record<string, string | string[]>
  export const SYMBOL: { SUMMARY: symbol; CONTENT: symbol }
  export function isOPDSCatalog(type: string): boolean
  export function getFeed(doc: Document): unknown
  export function getPublication(entry: Element): unknown
  export function getOpenSearch(doc: Document): unknown
  export function getSearch(link: unknown): Promise<unknown>
}
