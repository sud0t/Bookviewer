import { describe, expect, it } from 'vitest'
import { fitScale, pageAtFraction, usualPageSize, zoomStep, MAX_ZOOM, MIN_ZOOM } from '../../src/renderer/engines/pdf-text'

const A4 = { width: 793, height: 1121 }
const COVER = { width: 657, height: 945 }

describe('the page size that fit modes go by', () => {
  it('is the body pages\' size when the cover is smaller', () => {
    // C_Book_2nd.pdf: one 493 x 709 pt cover, then 216 A4 pages
    expect(usualPageSize([COVER, ...Array(216).fill(A4)])).toEqual(A4)
    expect(usualPageSize([COVER, A4])).toEqual(A4)
  })

  it('is not decided by one fold-out', () => {
    const foldOut = { width: 1587, height: 1121 }
    expect(usualPageSize([A4, A4, A4, foldOut, A4, A4])).toEqual(A4)
  })

  it('makes room for pages a little larger than most', () => {
    // scans that all differ slightly must all fit
    const scans = [780, 793, 799, 785, 801, 790].map(width => ({ width, height: 1100 }))
    expect(usualPageSize(scans).width).toBe(801)
  })

  it('handles a single page and no pages', () => {
    expect(usualPageSize([A4])).toEqual(A4)
    expect(usualPageSize([])).toEqual({ width: 0, height: 0 })
  })
})

describe('fitting a page to the window', () => {
  const room = { width: 1390, height: 809 }

  it('fits the width, leaving the margin pdf.js leaves', () => {
    const scale = fitScale('page-width', A4, room)
    expect(Math.round(A4.width * scale)).toBe(1350)
  })

  it('fits the whole page by whichever side is tighter', () => {
    const scale = fitScale('page-fit', A4, room)
    expect(Math.round(A4.height * scale)).toBe(804)
    expect(A4.width * scale).toBeLessThan(room.width)
    const wide = { width: 2000, height: 500 }
    expect(Math.round(wide.width * fitScale('page-fit', wide, room))).toBe(1350)
  })

  it('does not blow a small page up far past life size on "auto"', () => {
    expect(fitScale('auto', A4, room)).toBe(1.25)
    expect(fitScale('auto', A4, { width: 700, height: 809 })).toBeCloseTo(660 / A4.width)
  })
})

describe('zoom steps', () => {
  it('go up and down by about a tenth', () => {
    expect(zoomStep(1, 1)).toBe(1.1)
    expect(zoomStep(1.1, 1)).toBe(1.21)
    expect(zoomStep(1.1, -1)).toBe(1)
    expect(zoomStep(1.702, -1)).toBe(1.55)
  })

  it('stop at the limits', () => {
    expect(zoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(zoomStep(5.9, 1)).toBe(MAX_ZOOM)
    expect(zoomStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
    expect(zoomStep(0.26, -1)).toBe(MIN_ZOOM)
  })
})

describe('the page at a position in the book', () => {
  it('counts pages from one', () => {
    expect(pageAtFraction(0, 217)).toEqual({ page: 1, within: 0 })
    expect(pageAtFraction(0.5, 200)).toEqual({ page: 101, within: 0 })
    expect(pageAtFraction(0.3137, 1034).page).toBe(325)
    expect(pageAtFraction(0.3137, 1034).within).toBeCloseTo(0.3658, 3)
  })

  it('never runs past the last page', () => {
    expect(pageAtFraction(1, 217).page).toBe(217)
    expect(pageAtFraction(7, 217).page).toBe(217)
    expect(pageAtFraction(-1, 217)).toEqual({ page: 1, within: 0 })
    expect(pageAtFraction(Number.NaN, 217).page).toBe(1)
    expect(pageAtFraction(0.5, 0).page).toBe(1)
  })
})
