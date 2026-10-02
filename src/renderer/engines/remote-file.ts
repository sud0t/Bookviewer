import type { FileLike } from 'foliate-js/types'

const CHUNK = 1024 * 1024
const MAX_CACHED_CHUNKS = 24
/** Below this, just download the file: simpler, and plenty fast locally. */
const EAGER_LIMIT = 48 * 1024 * 1024

/**
 * A read-only, lazily fetched stand-in for a `File`, backed by HTTP range
 * requests. The format parsers only ever `slice()` and read, so a 100 MB
 * archive can be opened without pulling all of it into memory.
 */
export class RemoteFile implements FileLike {
  readonly type = ''
  private chunks = new Map<number, Promise<Uint8Array>>()

  constructor(
    readonly url: string,
    readonly name: string,
    readonly size: number,
  ) {}

  private chunk(index: number): Promise<Uint8Array> {
    let chunk = this.chunks.get(index)
    if (chunk) {
      // refresh its position in the LRU order
      this.chunks.delete(index)
    } else {
      const start = index * CHUNK
      const end = Math.min(this.size, start + CHUNK) - 1
      chunk = fetch(this.url, { headers: { range: `bytes=${start}-${end}` } }).then(async res => {
        if (!res.ok) throw new Error(`Reading ${this.name} failed: ${res.status}`)
        return new Uint8Array(await res.arrayBuffer())
      })
      chunk.catch(() => this.chunks.delete(index))
      if (this.chunks.size >= MAX_CACHED_CHUNKS)
        this.chunks.delete(this.chunks.keys().next().value!)
    }
    this.chunks.set(index, chunk)
    return chunk
  }

  async read(start: number, end: number): Promise<ArrayBuffer> {
    start = Math.max(0, Math.min(start, this.size))
    end = Math.max(start, Math.min(end, this.size))
    const out = new Uint8Array(end - start)
    if (!out.length) return out.buffer
    const first = Math.floor(start / CHUNK)
    const last = Math.floor((end - 1) / CHUNK)
    // Sequentially, so that a big read cannot evict its own chunks.
    for (let index = first; index <= last; index++) {
      const data = await this.chunk(index)
      const base = index * CHUNK
      const from = Math.max(start, base)
      const to = Math.min(end, base + data.length)
      out.set(data.subarray(from - base, to - base), from - start)
    }
    return out.buffer
  }

  slice(start = 0, end = this.size): { size: number; arrayBuffer(): Promise<ArrayBuffer> } {
    if (start < 0) start = Math.max(0, this.size + start)
    if (end < 0) end = Math.max(0, this.size + end)
    return {
      size: Math.max(0, Math.min(end, this.size) - start),
      arrayBuffer: () => this.read(start, end),
    }
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.read(0, this.size)
  }
}

/** Opens a `book://` URL as a file: fully in memory when small, lazily when big. */
export async function openRemote(url: string, name: string): Promise<FileLike> {
  const head = await fetch(url, { method: 'HEAD' })
  if (!head.ok) throw new Error(`Opening ${name} failed: ${head.status}`)
  const size = Number(head.headers.get('content-length') ?? 0)
  if (size > EAGER_LIMIT && head.headers.get('accept-ranges') === 'bytes')
    return new RemoteFile(url, name, size)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Opening ${name} failed: ${res.status}`)
  return new File([await res.blob()], name)
}
