/**
 * Opens the formats foliate-js understands (EPUB, MOBI/KF8, FB2, CBZ) as its
 * "book" objects. This is foliate's own `makeBook`, minus PDF (which has a
 * dedicated engine here) and reading through `FileLike` instead of `File`.
 */
import type { Book } from '@shared/types'
import { bookUrl } from '@shared/types'
import type { FileLike, FoliateBook, ZipLoader } from 'foliate-js/types'
import { openRemote } from './remote-file'

export type OpenFailure = 'damaged' | 'missing' | 'unreadable' | 'unsupported' | 'locked'

/** What the reader is told when a book cannot be opened: what happened, and what to do. */
const SENTENCES: Record<OpenFailure, (path: string) => string> = {
  damaged: () => 'This file is damaged or incomplete. Download or copy it again, then reopen it.',
  missing: path =>
    `Nothing was found at ${path}. The book may have been moved, renamed or deleted, or its drive is not connected.`,
  unreadable: () => 'This file could not be read. Check that you are allowed to open it, then try again.',
  unsupported: () =>
    'BookViewer cannot read this kind of file. It opens EPUB, MOBI, AZW3, FB2, CBZ and PDF files, and saved web pages.',
  locked: () =>
    'This PDF is locked with a password, which BookViewer cannot ask for yet. Save a copy without the password to read it here.',
}

/**
 * A book that could not be opened. `message` is a plain sentence for the
 * reader, shown as it is; what actually went wrong is in `cause`.
 */
export class OpenError extends Error {
  constructor(
    readonly kind: OpenFailure,
    path: string,
    cause?: unknown,
  ) {
    super(SENTENCES[kind](path), { cause })
    this.name = 'OpenError'
  }
}

/** The file's content is not any format we know (as opposed to a broken file of a known one). */
class UnknownFormat extends Error {}

/**
 * Turns whatever a parser or a failed request threw into an `OpenError`,
 * leaving the technical detail in the console.
 */
export function openFailure(error: unknown, path: string): OpenError {
  if (error instanceof OpenError) return error
  console.warn(`Opening ${path} failed:`, error)
  const { name, status, message } = (error ?? {}) as { name?: unknown; status?: unknown; message?: unknown }
  // a request for the file's bytes that got no answer at all (the file is
  // there, but reading it failed), or an answer other than "not found"
  const refused =
    typeof status === 'number' || (error instanceof TypeError && /failed to fetch|network error/i.test(String(message)))
  let kind: OpenFailure = 'damaged'
  if (status === 404) kind = 'missing'
  else if (refused) kind = 'unreadable'
  else if (name === 'PasswordException') kind = 'locked'
  else if (error instanceof UnknownFormat) kind = 'unsupported'
  return new OpenError(kind, path, error)
}

const startsWith = async (file: FileLike, bytes: number[]): Promise<boolean> => {
  const head = new Uint8Array(await file.slice(0, bytes.length).arrayBuffer())
  return bytes.every((byte, i) => head[i] === byte)
}

async function makeZipLoader(file: FileLike): Promise<ZipLoader> {
  const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } = await import(
    'foliate-js/vendor/zip.js'
  )
  configure({ useWebWorkers: false })
  const reader = new ZipReader(new BlobReader(file))
  const entries = await reader.getEntries()
  const map = new Map(entries.map(entry => [entry.filename, entry]))
  return {
    entries,
    loadText: name => map.get(name)?.getData(new TextWriter()) ?? null,
    loadBlob: (name, type) => map.get(name)?.getData(new BlobWriter(type)) ?? null,
    getSize: name => map.get(name)?.uncompressedSize ?? 0,
  }
}

export async function makeBook(file: FileLike): Promise<FoliateBook> {
  const name = file.name.toLowerCase()
  if (!file.size) throw new Error('The file is empty')

  if (await startsWith(file, [0x50, 0x4b, 0x03, 0x04])) {
    const loader = await makeZipLoader(file)
    if (name.endsWith('.cbz')) {
      const { makeComicBook } = await import('foliate-js/comic-book.js')
      return makeComicBook(loader, file)
    }
    if (name.endsWith('.fb2.zip') || name.endsWith('.fbz')) {
      const { makeFB2 } = await import('foliate-js/fb2.js')
      const entry = loader.entries.find(e => e.filename.endsWith('.fb2')) ?? loader.entries[0]
      const blob = await loader.loadBlob(entry.filename)
      if (!blob) throw new Error('The archive has no FB2 file')
      return makeFB2(blob)
    }
    const { EPUB } = await import('foliate-js/epub.js')
    return new EPUB(loader).init()
  }

  const { isMOBI, MOBI } = await import('foliate-js/mobi.js')
  if (await isMOBI(file)) {
    const { unzlibSync } = await import('foliate-js/vendor/fflate.js')
    return new MOBI({ unzlib: unzlibSync }).open(file)
  }
  if (name.endsWith('.fb2')) {
    const { makeFB2 } = await import('foliate-js/fb2.js')
    return makeFB2(file)
  }
  // A file that claims to be one of our formats but is not is a broken
  // file; only something else altogether is "not supported".
  if (/\.(epub|cbz|fbz|fb2\.zip|mobi|azw3?|kf8)$/.test(name))
    throw new Error(`${file.name} is not what its name says: no ZIP or MOBI signature`)
  throw new UnknownFormat(`${file.name} is in no known e-book format`)
}

export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export async function openFoliateBook(book: Book): Promise<FoliateBook> {
  const name = fileName(book.path)
  try {
    return await makeBook(await openRemote(bookUrl(book.id, name), name))
  } catch (error) {
    throw openFailure(error, book.path)
  }
}

type Localized = string | Record<string, string> | undefined

const localized = (value: Localized): string => {
  if (!value) return ''
  if (typeof value === 'string') return value
  return value.en ?? Object.values(value)[0] ?? ''
}

/** Flattens foliate's flexible contributor shapes into "A, B and C". */
export function contributors(value: unknown): string {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list
    .map(item =>
      typeof item === 'string' ? item : localized((item as { name?: Localized })?.name ?? (item as Localized)),
    )
    .filter(Boolean)
    .join(', ')
}

export const localizedText = localized
