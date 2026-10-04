import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, deflateRawSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DictionaryShelf, baseForms, plainText, readArticle, unwrap } from '../../src/main/stardict'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookviewer-dict-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** StarDict's ordering: ASCII case-insensitive, then by bytes. */
const order = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0
}

/** dictzip: gzip whose header lists chunks that each inflate on their own. */
function dictzip(data: Buffer, chunkLength: number): Buffer {
  const chunks: Buffer[] = []
  for (let at = 0; at < data.length; at += chunkLength)
    chunks.push(deflateRawSync(data.subarray(at, at + chunkLength), { finishFlush: constants.Z_FULL_FLUSH }))
  const extra = Buffer.alloc(10 + chunks.length * 2)
  extra.write('RA', 0, 'latin1')
  extra.writeUInt16LE(6 + chunks.length * 2, 2)
  extra.writeUInt16LE(1, 4)
  extra.writeUInt16LE(chunkLength, 6)
  extra.writeUInt16LE(chunks.length, 8)
  chunks.forEach((chunk, i) => extra.writeUInt16LE(chunk.length, 10 + i * 2))
  const head = Buffer.from([0x1f, 0x8b, 8, 4 | 8, 0, 0, 0, 0, 0, 3, 0, 0])
  head.writeUInt16LE(extra.length, 10)
  return Buffer.concat([head, extra, Buffer.from('words.dict\0', 'latin1'), ...chunks])
}

async function makeDictionary(
  folder: string,
  name: string,
  articles: Record<string, string>,
  options: { type?: string; compress?: 'dictzip' | 'gzip'; synonyms?: Record<string, string>; gzipIndex?: boolean } = {},
) {
  await mkdir(folder, { recursive: true })
  const words = Object.keys(articles).sort(order)
  const bodies: Buffer[] = []
  const index: Buffer[] = []
  let offset = 0
  for (const word of words) {
    const body = Buffer.from(articles[word], 'utf8')
    const tail = Buffer.alloc(8)
    tail.writeUInt32BE(offset, 0)
    tail.writeUInt32BE(body.length, 4)
    index.push(Buffer.from(word + '\0', 'utf8'), tail)
    bodies.push(body)
    offset += body.length
  }
  const dict = Buffer.concat(bodies)
  const idx = Buffer.concat(index)
  await writeFile(
    join(folder, `${name}.ifo`),
    `StarDict's dict ifo file\nversion=2.4.2\nbookname=${name} Dictionary\nwordcount=${words.length}\nidxfilesize=${idx.length}\nsametypesequence=${options.type ?? 'm'}\n`,
  )
  if (options.gzipIndex) await writeFile(join(folder, `${name}.idx.gz`), gzipSync(idx))
  else await writeFile(join(folder, `${name}.idx`), idx)
  if (options.compress === 'dictzip') await writeFile(join(folder, `${name}.dict.dz`), dictzip(dict, 64))
  else if (options.compress === 'gzip') await writeFile(join(folder, `${name}.dict.dz`), gzipSync(dict))
  else await writeFile(join(folder, `${name}.dict`), dict)
  if (options.synonyms) {
    const entries = Object.entries(options.synonyms).sort(([a], [b]) => order(a, b))
    await writeFile(
      join(folder, `${name}.syn`),
      Buffer.concat(
        entries.flatMap(([synonym, word]) => {
          const target = Buffer.alloc(4)
          target.writeUInt32BE(words.indexOf(word))
          return [Buffer.from(synonym + '\0', 'utf8'), target]
        }),
      ),
    )
  }
}

const WORDS = {
  apple: 'A round fruit with red or green skin.',
  Apple: 'A maker of computers.',
  lighthouse: 'A tower with a bright light that guides ships. ' + 'It stands on the shore. '.repeat(20),
  run: 'To move fast on foot.',
  zèbre: 'Un animal rayé.',
}

describe('offline dictionaries', () => {
  it('finds dictionaries in a folder and looks words up in them', async () => {
    await makeDictionary(join(dir, 'english'), 'plain', WORDS)
    const shelf = new DictionaryShelf(() => [dir, join(dir, 'nowhere')])
    expect(await shelf.list()).toEqual([
      { name: 'plain Dictionary', words: 5, path: join(dir, 'english', 'plain.ifo') },
    ])

    const [run] = await shelf.lookup('run')
    expect(run).toMatchObject({ word: 'run', text: 'To move fast on foot.', source: 'plain Dictionary' })
    expect((await shelf.lookup('zèbre'))[0].text).toBe('Un animal rayé.')
    expect(await shelf.lookup('nonesuch')).toEqual([])
    expect(await shelf.lookup('   ')).toEqual([])
  })

  it('finds a word whatever its capitals, the spelling asked for first', async () => {
    await makeDictionary(dir, 'plain', WORDS)
    const shelf = new DictionaryShelf(() => [dir])
    expect((await shelf.lookup('Apple')).map(entry => entry.word)).toEqual(['Apple', 'apple'])
    expect((await shelf.lookup('apple')).map(entry => entry.word)).toEqual(['apple', 'Apple'])
    expect((await shelf.lookup('LIGHTHOUSE'))[0].word).toBe('lighthouse')
  })

  it('reads compressed dictionaries: dictzip chunks, plain gzip, a gzipped index', async () => {
    await makeDictionary(join(dir, 'a'), 'chunked', WORDS, { compress: 'dictzip' })
    await makeDictionary(join(dir, 'b'), 'whole', WORDS, { compress: 'gzip', gzipIndex: true })
    const shelf = new DictionaryShelf(() => [dir])
    const hits = await shelf.lookup('lighthouse')
    expect(hits.map(hit => hit.source)).toEqual(['chunked Dictionary', 'whole Dictionary'])
    // (the article runs over several of the 64-byte chunks)
    for (const hit of hits) expect(hit.text).toBe(WORDS.lighthouse.trim())
    expect((await shelf.lookup('zèbre')).map(hit => hit.text)).toEqual(['Un animal rayé.', 'Un animal rayé.'])
  })

  it('follows synonyms and falls back on the base form of an inflected word', async () => {
    await makeDictionary(dir, 'plain', WORDS, { synonyms: { beacon: 'lighthouse', ran: 'run' } })
    const shelf = new DictionaryShelf(() => [dir])
    expect((await shelf.lookup('beacon'))[0].word).toBe('lighthouse')
    expect((await shelf.lookup('ran'))[0].word).toBe('run')
    expect((await shelf.lookup('apples'))[0].word).toBe('apple')
    expect((await shelf.lookup('running'))[0].word).toBe('run')
    expect((await shelf.lookup('lighthouse’s'))[0].word).toBe('lighthouse')
  })

  it('turns marked-up articles into text', async () => {
    await makeDictionary(dir, 'html', { tea: '<k>tea</k><b>tea</b> <i>n.</i><br>1. A drink &amp; a meal.<ul><li>green</li><li>black</li></ul>' }, { type: 'h' })
    const shelf = new DictionaryShelf(() => [dir])
    expect((await shelf.lookup('tea'))[0].text).toBe('tea n.\n1. A drink & a meal.\n• green\n• black')
    expect(plainText('a&#233;&#x41;&nbsp;b<script>x</script>')).toBe('aéA b')
  })

  it('reads articles made of several typed fields', () => {
    const sequenced = Buffer.concat([Buffer.from('tiː\0', 'utf8'), Buffer.from('A drink.', 'utf8')])
    expect(readArticle(sequenced, 'tm')).toEqual({ text: 'A drink.', phonetic: 'tiː' })
    // without a declared sequence each field names its own type
    const tagged = Buffer.concat([Buffer.from('ttiː\0', 'utf8'), Buffer.from('mA drink.\0', 'utf8')])
    expect(readArticle(tagged, '')).toEqual({ text: 'A drink.', phonetic: 'tiː' })
    // a picture in between is skipped by its length
    const size = Buffer.alloc(4)
    size.writeUInt32BE(3)
    const withPicture = Buffer.concat([Buffer.from('P'), size, Buffer.from([1, 2, 3]), Buffer.from('mA drink.\0', 'utf8')])
    expect(readArticle(withPicture, '').text).toBe('A drink.')
  })

  it('ignores folders with incomplete dictionaries, and picks up new ones when asked', async () => {
    await mkdir(join(dir, 'broken'))
    await writeFile(join(dir, 'broken', 'half.ifo'), "StarDict's dict ifo file\nbookname=Half\n")
    await writeFile(join(dir, 'notes.ifo'), 'not a dictionary')
    const shelf = new DictionaryShelf(() => [dir])
    expect(await shelf.list()).toEqual([])
    await makeDictionary(dir, 'plain', WORDS)
    expect(await shelf.list()).toEqual([])
    shelf.refresh()
    expect((await shelf.list()).map(d => d.name)).toEqual(['plain Dictionary'])
  })

  it('puts hard-wrapped paragraphs back together, keeping numbered senses apart', () => {
    expect(
      unwrap('Tea \\Tea\\, n.\n   1. A drink made by steeping\n      leaves in water.\n   2. A meal.\n\n   Syn: brew.'),
    ).toBe('Tea \\Tea\\, n.\n1. A drink made by steeping leaves in water.\n2. A meal.\n\nSyn: brew.')
  })

  it('guesses base forms', () => {
    expect(baseForms('Stopped')).toEqual(expect.arrayContaining(['stop']))
    expect(baseForms('making')).toEqual(expect.arrayContaining(['make']))
    expect(baseForms('studies')).toEqual(expect.arrayContaining(['study']))
    expect(baseForms('cat')).toEqual([])
  })
})
