/**
 * Offline dictionaries in the StarDict format, so that looking a word up
 * needs no network: a `.ifo` file describing the dictionary, a `.idx` index
 * of its words (optionally `.idx.gz`), the articles in `.dict` or `.dict.dz`,
 * and optionally a `.syn` file of alternative spellings.
 *
 * Kept free of Electron imports so that it can be tested.
 */
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { constants, gunzipSync, inflateRawSync } from 'node:zlib'
import type { DictionaryEntry, OfflineDictionary } from '@shared/types'

const MAX_DEPTH = 3
const MAX_ARTICLE_CHARS = 6000
const MAX_HITS_PER_DICTIONARY = 4

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    info => info.isFile(),
    () => false,
  )

/** Lowercases the ASCII letters only, as StarDict's ordering does. */
const fold = (byte: number): number => (byte >= 65 && byte <= 90 ? byte + 32 : byte)

/** Compares a word with the bytes of an index entry, ignoring ASCII case. */
function compareFolded(word: Uint8Array, data: Uint8Array, start: number, end: number): number {
  const length = Math.min(word.length, end - start)
  for (let i = 0; i < length; i++) {
    const difference = fold(word[i]) - fold(data[start + i])
    if (difference) return difference
  }
  return word.length - (end - start)
}

/** A sorted list of NUL-terminated words, each followed by `tail` bytes of payload. */
class WordIndex {
  /** Where each entry's word starts; its payload follows the terminating NUL. */
  private starts: number[] = []
  private ends: number[] = []

  constructor(
    readonly data: Buffer,
    tail: number,
  ) {
    for (let at = 0; at < data.length; ) {
      const nul = data.indexOf(0, at)
      if (nul < 0 || nul + 1 + tail > data.length) break
      this.starts.push(at)
      this.ends.push(nul)
      at = nul + 1 + tail
    }
  }

  get size(): number {
    return this.starts.length
  }

  word(index: number): string {
    return this.data.toString('utf8', this.starts[index], this.ends[index])
  }

  /** Offset of an entry's payload in the buffer. */
  payload(index: number): number {
    return this.ends[index] + 1
  }

  /** Every entry spelled like `word`, give or take ASCII case. */
  find(word: string): number[] {
    const bytes = Buffer.from(word, 'utf8')
    let low = 0
    let high = this.starts.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (compareFolded(bytes, this.data, this.starts[middle], this.ends[middle]) > 0) low = middle + 1
      else high = middle
    }
    const found: number[] = []
    for (let i = low; i < this.starts.length && found.length < 16; i++) {
      if (compareFolded(bytes, this.data, this.starts[i], this.ends[i]) !== 0) break
      found.push(i)
    }
    return found
  }
}

/** Reads byte ranges of a `.dict` file, compressed (dictzip) or not. */
class ArticleFile {
  private chunks: { length: number; offsets: number[]; sizes: number[] } | null = null
  private whole: Buffer | null = null
  private ready: Promise<void> | null = null

  constructor(
    private path: string,
    private compressed: boolean,
  ) {}

  /** dictzip is gzip cut into chunks that inflate on their own, listed in the header. */
  private async prepare(): Promise<void> {
    const file = await open(this.path, 'r')
    try {
      const head = Buffer.alloc(12)
      await file.read(head, 0, 12, 0)
      const flags = head[3]
      let at = 10
      if (head[0] === 0x1f && head[1] === 0x8b && flags & 4) {
        const extraLength = head.readUInt16LE(10)
        const extra = Buffer.alloc(extraLength)
        await file.read(extra, 0, extraLength, 12)
        at = 12 + extraLength
        for (let field = 0; field + 4 <= extra.length; ) {
          const length = extra.readUInt16LE(field + 2)
          if (extra[field] === 0x52 && extra[field + 1] === 0x41 && length >= 6) {
            const chunkLength = extra.readUInt16LE(field + 6)
            const count = extra.readUInt16LE(field + 8)
            const sizes: number[] = []
            for (let i = 0; i < count && field + 12 + i * 2 <= extra.length; i++)
              sizes.push(extra.readUInt16LE(field + 10 + i * 2))
            this.chunks = { length: chunkLength, offsets: [], sizes }
          }
          field += 4 + length
        }
      }
      if (!this.chunks?.length) {
        // plain gzip: there is no reading a part of it
        this.chunks = null
        this.whole = gunzipSync(await readFile(this.path))
        return
      }
      // skip the file name, comment and header checksum to where the data starts
      const rest = Buffer.alloc(1024)
      const { bytesRead } = await file.read(rest, 0, rest.length, at)
      let skip = 0
      for (const flag of [8, 16])
        if (flags & flag) {
          const nul = rest.indexOf(0, skip)
          skip = nul < 0 || nul >= bytesRead ? bytesRead : nul + 1
        }
      if (flags & 2) skip += 2
      let offset = at + skip
      for (const size of this.chunks.sizes) {
        this.chunks.offsets.push(offset)
        offset += size
      }
    } finally {
      await file.close()
    }
  }

  async read(offset: number, size: number): Promise<Buffer> {
    if (!this.compressed) {
      const file = await open(this.path, 'r')
      try {
        const buffer = Buffer.alloc(size)
        const { bytesRead } = await file.read(buffer, 0, size, offset)
        return buffer.subarray(0, bytesRead)
      } finally {
        await file.close()
      }
    }
    await (this.ready ??= this.prepare())
    if (this.whole) return this.whole.subarray(offset, offset + size)
    const { length, offsets, sizes } = this.chunks!
    const first = Math.floor(offset / length)
    const last = Math.min(sizes.length - 1, Math.floor((offset + size - 1) / length))
    if (first > last) return Buffer.alloc(0)
    const file = await open(this.path, 'r')
    try {
      const parts: Buffer[] = []
      for (let i = first; i <= last; i++) {
        const packed = Buffer.alloc(sizes[i])
        await file.read(packed, 0, sizes[i], offsets[i])
        parts.push(inflateRawSync(packed, { finishFlush: constants.Z_SYNC_FLUSH }))
      }
      const start = offset - first * length
      return Buffer.concat(parts).subarray(start, start + size)
    } finally {
      await file.close()
    }
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Marked-up article text (HTML, Pango, XDXF) as plain text with its line breaks. */
export function plainText(markup: string): string {
  return markup
    .replace(/<(style|script|k)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|dt|dd|h[1-6]|blockquote|def|ul|ol)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Plain-text articles converted from dictd files come wrapped at 70-odd
 * columns with a hanging indent; put each paragraph back on one line so
 * that it wraps to the window instead. Numbered senses and blank lines
 * still start a new line.
 */
export function unwrap(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\n[ \t]+(?=\S)(?!(?:\d+\.|\([a-z0-9]+\)|--|\[|•|Syn:|Note:)\s?)/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Splits an article into its typed fields and renders the ones that are text. */
export function readArticle(data: Buffer, sequence: string): { text: string; phonetic: string } {
  const texts: string[] = []
  let phonetic = ''
  const take = (type: string, value: Buffer) => {
    if (type === 't' || type === 'y') phonetic ||= value.toString('utf8').trim()
    else if (type === 'm' || type === 'l') texts.push(unwrap(value.toString('utf8')))
    else if ('ghxkw'.includes(type)) texts.push(plainText(value.toString('utf8')))
    // (pictures, sound and resource lists have nothing to show here)
  }
  let at = 0
  const fields = sequence ? [...sequence] : null
  for (let i = 0; at < data.length && (!fields || i < fields.length); i++) {
    const type = fields ? fields[i] : String.fromCharCode(data[at++])
    const lastOfSequence = !!fields && i === fields.length - 1
    let end: number
    if (type >= 'A' && type <= 'Z') {
      // binary: a length, then that many bytes (the length is left out at the very end)
      if (lastOfSequence) end = data.length
      else {
        if (at + 4 > data.length) break
        const size = data.readUInt32BE(at)
        at += 4
        end = Math.min(data.length, at + size)
      }
      take(type, data.subarray(at, end))
      at = end
    } else {
      const nul = lastOfSequence ? -1 : data.indexOf(0, at)
      end = nul < 0 ? data.length : nul
      take(type, data.subarray(at, end))
      at = end + 1
    }
  }
  return { text: texts.filter(Boolean).join('\n\n').slice(0, MAX_ARTICLE_CHARS), phonetic }
}

/** A word's likely dictionary forms, for a text that has it inflected (English only, and crude). */
export function baseForms(word: string): string[] {
  const lower = word.toLowerCase()
  const forms = new Set<string>()
  const add = (form: string) => {
    if (form.length >= 2 && form !== lower) forms.add(form)
  }
  add(lower.replace(/['’]s$/, ''))
  if (lower.endsWith('ies')) add(lower.slice(0, -3) + 'y')
  if (lower.endsWith('es')) add(lower.slice(0, -2))
  if (lower.endsWith('s')) add(lower.slice(0, -1))
  if (lower.endsWith('ied')) add(lower.slice(0, -3) + 'y')
  if (lower.endsWith('ed')) {
    add(lower.slice(0, -2))
    add(lower.slice(0, -1))
    // "stopped" -> "stop"
    if (/([a-z])\1ed$/.test(lower)) add(lower.slice(0, -3))
  }
  if (lower.endsWith('ing')) {
    add(lower.slice(0, -3))
    add(lower.slice(0, -3) + 'e')
    if (/([a-z])\1ing$/.test(lower)) add(lower.slice(0, -4))
  }
  if (lower.endsWith('ly')) add(lower.slice(0, -2))
  return [...forms]
}

export class Dictionary {
  private index: WordIndex | null = null
  private synonyms: WordIndex | null = null
  private loading: Promise<void> | null = null
  private articles: ArticleFile

  private constructor(
    readonly info: OfflineDictionary,
    private base: string,
    private idxPath: string,
    dictPath: string,
    private offsetBytes: 4 | 8,
    private sequence: string,
  ) {
    this.articles = new ArticleFile(dictPath, dictPath.endsWith('.dz'))
  }

  /** Reads a dictionary's description; null when its files are not all there. */
  static async open(ifoPath: string): Promise<Dictionary | null> {
    let text: string
    try {
      text = await readFile(ifoPath, 'utf8')
    } catch {
      return null
    }
    if (!text.startsWith("StarDict's dict ifo file")) return null
    const fields = new Map<string, string>()
    for (const line of text.split(/\r?\n/)) {
      const equals = line.indexOf('=')
      if (equals > 0) fields.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim())
    }
    const base = ifoPath.replace(/\.ifo$/i, '')
    const idxPath = [`${base}.idx`, `${base}.idx.gz`]
    const dictPath = [`${base}.dict.dz`, `${base}.dict`]
    const idx = (await exists(idxPath[0])) ? idxPath[0] : (await exists(idxPath[1])) ? idxPath[1] : null
    const dict = (await exists(dictPath[0])) ? dictPath[0] : (await exists(dictPath[1])) ? dictPath[1] : null
    if (!idx || !dict) return null
    return new Dictionary(
      {
        name: fields.get('bookname') || base.slice(base.lastIndexOf('/') + 1),
        words: Number(fields.get('wordcount')) || 0,
        path: ifoPath,
      },
      base,
      idx,
      dict,
      fields.get('idxoffsetbits') === '64' ? 8 : 4,
      fields.get('sametypesequence') ?? '',
    )
  }

  /** The index is only read when the first word is looked up. */
  private async load(): Promise<void> {
    const raw = await readFile(this.idxPath)
    this.index = new WordIndex(this.idxPath.endsWith('.gz') ? gunzipSync(raw) : raw, this.offsetBytes + 4)
    const syn = `${this.base}.syn`
    if (await exists(syn)) this.synonyms = new WordIndex(await readFile(syn), 4)
  }

  async lookup(word: string): Promise<{ word: string; text: string; phonetic: string }[]> {
    await (this.loading ??= this.load())
    const index = this.index!
    const hits = new Set<number>(index.find(word))
    if (this.synonyms)
      for (const entry of this.synonyms.find(word)) {
        const target = this.synonymTarget(entry)
        if (target < index.size) hits.add(target)
      }
    // the spelling as written before its other capitalisations
    const ordered = [...hits].sort((a, b) => Number(index.word(b) === word) - Number(index.word(a) === word))
    const results = []
    for (const entry of ordered.slice(0, MAX_HITS_PER_DICTIONARY)) {
      const at = index.payload(entry)
      const { data } = index
      const offset = this.offsetBytes === 8 ? Number(data.readBigUInt64BE(at)) : data.readUInt32BE(at)
      const size = data.readUInt32BE(at + this.offsetBytes)
      if (size > 4 * 1024 * 1024) continue
      const article = readArticle(await this.articles.read(offset, size), this.sequence)
      if (article.text) results.push({ word: index.word(entry), ...article })
    }
    return results
  }

  private synonymTarget(entry: number): number {
    const synonyms = this.synonyms!
    return synonyms.data.readUInt32BE(synonyms.payload(entry))
  }
}

async function findIfoFiles(dir: string, depth = 0): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth < MAX_DEPTH && !entry.name.startsWith('.'))
      found.push(...(await findIfoFiles(path, depth + 1)))
    else if (/\.ifo$/i.test(entry.name)) found.push(path)
  }
  return found
}

/** The offline dictionaries found in a set of folders. */
export class DictionaryShelf {
  private opened = new Map<string, Dictionary | null>()
  private current: Dictionary[] = []
  private scanned = ''

  /** `folders` is asked afresh each time, so a changed setting is picked up. */
  constructor(private folders: () => string[]) {}

  private async dictionaries(): Promise<Dictionary[]> {
    const folders = this.folders()
    const key = folders.join('\n')
    if (key === this.scanned) return this.current
    const found: Dictionary[] = []
    for (const folder of folders)
      for (const ifo of await findIfoFiles(folder)) {
        if (!this.opened.has(ifo)) this.opened.set(ifo, await Dictionary.open(ifo))
        const dictionary = this.opened.get(ifo)
        if (dictionary && !found.includes(dictionary)) found.push(dictionary)
      }
    this.current = found
    this.scanned = key
    return found
  }

  /** Looks at the folders again (dictionaries were added or removed). */
  refresh(): void {
    this.scanned = ''
    this.opened.clear()
  }

  async list(): Promise<OfflineDictionary[]> {
    return (await this.dictionaries()).map(dictionary => dictionary.info)
  }

  async lookup(query: string): Promise<DictionaryEntry[]> {
    const word = query.replace(/\s+/g, ' ').trim().slice(0, 100)
    if (!word) return []
    const dictionaries = await this.dictionaries()
    const search = async (candidate: string): Promise<DictionaryEntry[]> => {
      const entries: DictionaryEntry[] = []
      for (const dictionary of dictionaries) {
        try {
          for (const hit of await dictionary.lookup(candidate))
            entries.push({
              word: hit.word,
              phonetic: hit.phonetic,
              meanings: [],
              text: hit.text,
              source: dictionary.info.name,
            })
        } catch (error) {
          console.warn(`Looking up in ${dictionary.info.path} failed:`, error)
        }
      }
      return entries
    }
    const direct = await search(word)
    if (direct.length) return direct
    for (const form of baseForms(word)) {
      const entries = await search(form)
      if (entries.length) return entries
    }
    return []
  }
}
