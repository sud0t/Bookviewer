/** Small pure helpers, kept free of Electron imports so they are easy to test. */
import { join, resolve, sep } from 'node:path'

/** Resolves `relative` under `root`, refusing anything that climbs out of it. */
export function safeJoin(root: string, relative: string): string | null {
  const base = resolve(root)
  const target = resolve(join(base, relative))
  return target === base || target.startsWith(base + sep) ? target : null
}

/** Parses a single-range `Range` header. */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return 'invalid'
  let start: number
  let end: number
  if (!match[1]) {
    // suffix range: the last N bytes
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

/** Makes a string safe to use as a file name on any common filesystem. */
export const sanitizeFilename = (name: string): string =>
  name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 180)
