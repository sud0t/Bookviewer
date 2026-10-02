import type { PdfRect } from '@shared/types'

/** Joins rectangles that sit side by side on one line of text. */
export function mergeRects(rects: PdfRect[]): PdfRect[] {
  const normalized = rects
    .map(([x1, y1, x2, y2]): PdfRect => [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ])
    .filter(([x1, y1, x2, y2]) => x2 - x1 > 0.1 && y2 - y1 > 0.1)
    // top to bottom (PDF y grows upwards)
    .sort((a, b) => b[3] - a[3])

  // First sort the rectangles into lines...
  const lines: PdfRect[][] = []
  for (const rect of normalized) {
    const line = lines.find(([first]) => {
      const height = Math.min(first[3] - first[1], rect[3] - rect[1])
      const overlap = Math.min(first[3], rect[3]) - Math.max(first[1], rect[1])
      return overlap > height * 0.6
    })
    if (line) line.push(rect)
    else lines.push([rect])
  }

  // ...then, left to right within each line, join the ones that touch
  // (allowing for the width of a space), but not across a column gutter.
  const merged: PdfRect[] = []
  for (const line of lines) {
    line.sort((a, b) => a[0] - b[0])
    let current: PdfRect = [...line[0]]
    for (const rect of line.slice(1)) {
      const height = Math.min(current[3] - current[1], rect[3] - rect[1])
      if (rect[0] <= current[2] + height * 0.6) {
        current[1] = Math.min(current[1], rect[1])
        current[2] = Math.max(current[2], rect[2])
        current[3] = Math.max(current[3], rect[3])
      } else {
        merged.push(current)
        current = [...rect]
      }
    }
    merged.push(current)
  }
  return merged
}
