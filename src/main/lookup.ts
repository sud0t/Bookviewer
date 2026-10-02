import { net } from 'electron'
import type { DictionaryEntry, WikipediaSummary } from '@shared/types'

const HEADERS = {
  'user-agent': 'BookViewer/0.1 (desktop e-book reader)',
  accept: 'application/json',
}

const languageCode = (language: string): string => {
  const code = language.toLowerCase().split(/[-_]/)[0]
  return /^[a-z]{2,3}$/.test(code) ? code : 'en'
}

async function getJson(url: string, timeout = 8000): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await net.fetch(url, { headers: HEADERS, signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const stripTags = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()

interface RawSummary {
  type?: string
  title?: string
  description?: string
  extract?: string
  thumbnail?: { source?: string }
  content_urls?: { desktop?: { page?: string } }
}

export async function wikipedia(query: string, language: string): Promise<WikipediaSummary | null> {
  const term = query.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!term) return null
  const base = `https://${languageCode(language)}.wikipedia.org`
  const summary = async (title: string): Promise<WikipediaSummary | null> => {
    const raw = (await getJson(
      `${base}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`,
    )) as RawSummary | null
    if (!raw?.title || !raw.extract) return null
    return {
      title: raw.title,
      description: raw.description ?? '',
      extract: raw.extract,
      thumbnail: raw.thumbnail?.source ?? null,
      url: raw.content_urls?.desktop?.page ?? `${base}/wiki/${encodeURIComponent(raw.title)}`,
    }
  }
  const direct = await summary(term)
  if (direct) return direct
  // Not an exact title: take the best search hit.
  const search = (await getJson(
    `${base}/w/rest.php/v1/search/page?q=${encodeURIComponent(term)}&limit=1`,
  )) as { pages?: { key?: string }[] } | null
  const key = search?.pages?.[0]?.key
  return key ? summary(key.replace(/_/g, ' ')) : null
}

interface RawEntry {
  word?: string
  phonetic?: string
  phonetics?: { text?: string }[]
  meanings?: {
    partOfSpeech?: string
    definitions?: { definition?: string; example?: string }[]
  }[]
}

interface RawWiktionary {
  [language: string]: {
    partOfSpeech?: string
    language?: string
    definitions?: { definition?: string; examples?: string[] }[]
  }[]
}

async function freeDictionary(word: string, code: string): Promise<DictionaryEntry[]> {
  const raw = (await getJson(
    `https://api.dictionaryapi.dev/api/v2/entries/${code}/${encodeURIComponent(word)}`,
  )) as RawEntry[] | null
  if (!Array.isArray(raw)) return []
  return raw.map(entry => ({
    word: entry.word ?? word,
    phonetic: entry.phonetic ?? entry.phonetics?.find(p => p.text)?.text ?? '',
    meanings: (entry.meanings ?? []).map(meaning => ({
      partOfSpeech: meaning.partOfSpeech ?? '',
      definitions: (meaning.definitions ?? []).slice(0, 6).map(def => ({
        definition: def.definition ?? '',
        example: def.example ?? '',
      })),
    })),
    source: 'Free Dictionary API',
  }))
}

async function wiktionary(word: string, code: string): Promise<DictionaryEntry[]> {
  // Wiktionary titles are case-sensitive: try the word as written, then lowercased.
  for (const candidate of new Set([word, word.toLowerCase()])) {
    const wiki = (await getJson(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(candidate)}`,
    )) as RawWiktionary | null
    if (!wiki) continue
    const sections = wiki[code] ?? Object.values(wiki)[0]
    if (!Array.isArray(sections) || !sections.length) continue
    const meanings = sections
      .map(section => ({
        partOfSpeech: section.partOfSpeech ?? '',
        definitions: (section.definitions ?? [])
          .map(def => ({
            definition: stripTags(def.definition ?? ''),
            example: stripTags(def.examples?.[0] ?? ''),
          }))
          .filter(def => def.definition)
          .slice(0, 6),
      }))
      .filter(meaning => meaning.definitions.length)
    if (meanings.length) return [{ word: candidate, phonetic: '', meanings, source: 'Wiktionary' }]
  }
  return []
}

export async function dictionary(query: string, language: string): Promise<DictionaryEntry[]> {
  const word = query.replace(/\s+/g, ' ').trim().slice(0, 100)
  if (!word) return []
  const code = languageCode(language)
  // Ask both at once. The Free Dictionary's entries read better (phonetics,
  // examples) but the service is often slow or down; Wiktionary knows more
  // words and inflected forms. Give the former a short head start.
  const free = freeDictionary(word, code).catch((): DictionaryEntry[] => [])
  const wiki = wiktionary(word, code).catch((): DictionaryEntry[] => [])
  const quick = await Promise.race([
    free,
    new Promise<null>(resolve => setTimeout(() => resolve(null), 2500)),
  ])
  if (quick?.length) return quick
  const fallback = await wiki
  if (fallback.length) return fallback
  return free
}
