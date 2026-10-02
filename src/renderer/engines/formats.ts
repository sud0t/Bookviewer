/**
 * Opens the formats foliate-js understands (EPUB, MOBI/KF8, FB2, CBZ) as its
 * "book" objects. This is foliate's own `makeBook`, minus PDF (which has a
 * dedicated engine here) and reading through `FileLike` instead of `File`.
 */
import type { Book } from '@shared/types'
import { bookUrl } from '@shared/types'
import type { FileLike, FoliateBook, ZipLoader } from 'foliate-js/types'
import { openRemote } from './remote-file'

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
  throw new Error('This file type is not supported')
}

export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export async function openFoliateBook(book: Book): Promise<FoliateBook> {
  const name = fileName(book.path)
  return makeBook(await openRemote(bookUrl(book.id, name), name))
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
