import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Covers are extracted in the renderer and cached as WebP, one per book. */
export const coverFile = (dir: string, bookId: number): string => join(dir, `${bookId}.webp`)

const MAX_COVER_BYTES = 4 * 1024 * 1024

export async function saveCover(dir: string, bookId: number, bytes: Uint8Array): Promise<boolean> {
  // RIFF....WEBP
  const isWebp =
    bytes.length > 12 &&
    bytes.length <= MAX_COVER_BYTES &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  if (!isWebp) return false
  await mkdir(dir, { recursive: true })
  await writeFile(coverFile(dir, bookId), bytes)
  return true
}

export async function removeCover(dir: string, bookId: number): Promise<void> {
  await rm(coverFile(dir, bookId), { force: true })
}
