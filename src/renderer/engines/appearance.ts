/**
 * Styling of book content: themes, typography, and making images behave in
 * dark themes. Works on the same-origin iframe documents the renderers load.
 */
import type { ThemeName } from '@shared/types'
import { READING_FONT, readingFontCSS } from './fonts'
import type { Appearance } from './types'

interface Palette {
  bg: string
  fg: string
  link: string
  /**
   * Dark themes are produced by inverting the rendered page (see
   * `INVERT_FILTER`) rather than by overriding the book's colours one by
   * one: whatever the publisher's stylesheet does - coloured callouts,
   * syntax highlighting, table stripes - stays legible and keeps its hue.
   */
  invert: boolean
}

export const PALETTES: Record<ThemeName, Palette> = {
  light: { bg: '#ffffff', fg: '#1f1d1a', link: '#2f5f9e', invert: false },
  sepia: { bg: '#f4ecd8', fg: '#4f3f2d', link: '#8a4b1c', invert: false },
  gray: { bg: '#353535', fg: '#dcdcdc', link: '#8fbcf0', invert: true },
  dark: { bg: '#1c1b1a', fg: '#d2cdc4', link: '#8ab4e8', invert: true },
  black: { bg: '#000000', fg: '#b8b8b8', link: '#7fa8dc', invert: true },
}

export const INVERT_FILTER = 'invert(1) hue-rotate(180deg)'

const clamp = (value: number): number => Math.min(255, Math.max(0, Math.round(value)))

/** The colour that `INVERT_FILTER` turns into `hex`. */
export function preInvert(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255]
  // hue-rotate(180deg) is its own inverse; undo it, then undo the inversion.
  const rotated = [
    -0.574 * r + 1.43 * g + 0.144 * b,
    0.426 * r + 0.43 * g + 0.144 * b,
    0.426 * r + 1.43 * g - 0.856 * b,
  ]
  return '#' + rotated.map(v => clamp(255 - v).toString(16).padStart(2, '0')).join('')
}

const FONT_STACKS: Record<string, string> = {
  serif: `'${READING_FONT}', 'Literata', 'Source Serif 4', 'Noto Serif', 'Liberation Serif', Georgia, serif`,
  'sans-serif':
    "'Inter', 'Adwaita Sans', 'Noto Sans', 'Cantarell', 'Liberation Sans', system-ui, sans-serif",
  monospace: "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono', monospace",
}

export function fontStack(family: string): string {
  if (FONT_STACKS[family]) return FONT_STACKS[family]
  // A font the user typed in; quote it and fall back to serif.
  return `'${family.replace(/['\\]/g, '')}', serif`
}

/** Elements whose own font and colours should be left alone. */
const CODE = 'pre, pre *, code, code *, kbd, samp, tt, math, math *, svg, svg *'

export function contentCSS({ settings, theme }: Appearance): string {
  const palette = PALETTES[theme]
  const bg = palette.invert ? preInvert(palette.bg) : palette.bg
  const fg = palette.invert ? preInvert(palette.fg) : palette.fg
  const link = palette.invert ? preInvert(palette.link) : palette.link
  const own = !settings.publisherStyles

  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    ${own ? readingFontCSS() : ''}
    html, body {
      background: ${bg} !important;
      color: ${fg} !important;
    }
    html {
      color-scheme: light;
      -webkit-text-size-adjust: none;
    }
    a:any-link { color: ${link}; }
    ::selection { background: ${palette.invert ? preInvert('#3b82f6') + '77' : '#3b82f655'}; }
    ${
      own
        ? `
    body, body *:not(${CODE}) {
      font-family: ${fontStack(settings.fontFamily)} !important;
    }
    p, li, blockquote, dd, dt {
      line-height: ${settings.lineHeight} !important;
      text-align: ${settings.justify ? 'justify' : 'start'};
      hyphens: ${settings.hyphenate ? 'auto' : 'manual'};
      -webkit-hyphenate-limit-before: 3;
      -webkit-hyphenate-limit-after: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }`
        : ''
    }
    pre {
      white-space: pre-wrap !important;
      overflow-wrap: anywhere;
      tab-size: 4;
    }
    img, svg, video, canvas { max-width: 100%; }
    img { height: auto; }
    ${
      palette.invert
        ? `
    /* Put pictures back the right way round. Diagrams drawn for a white
       page (marked by classifyImages) stay inverted with the text. */
    img:not([data-bv-inverted]), video, svg image:not([data-bv-inverted]) {
      filter: ${INVERT_FILTER};
    }`
        : ''
    }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] {
      display: none;
    }
  `
}

interface NaturalSizes {
  html: number
  body: number
}

const natural = new WeakMap<Document, NaturalSizes>()
const sizeStyles = new WeakMap<Document, HTMLStyleElement>()

/**
 * Scales a document so that its body text renders at `fontSize` px, whatever
 * unit games its stylesheet plays (mdBook, for one, sets the root to 62.5%).
 * Everything sized in em/rem follows along proportionally.
 */
export function applyFontSize(doc: Document, fontSize: number): void {
  const view = doc.defaultView
  if (!view || !doc.body || !doc.head) return
  let style = sizeStyles.get(doc)
  if (!style) {
    style = doc.createElement('style')
    doc.head.append(style)
    sizeStyles.set(doc, style)
  }
  let sizes = natural.get(doc)
  if (!sizes) {
    style.textContent = ''
    sizes = {
      html: parseFloat(view.getComputedStyle(doc.documentElement).fontSize) || 16,
      body: parseFloat(view.getComputedStyle(doc.body).fontSize) || 16,
    }
    natural.set(doc, sizes)
  }
  const root = (sizes.html * fontSize) / sizes.body
  style.textContent = `html { font-size: ${root.toFixed(3)}px !important; }`
  // A body sized in absolute units ignores the root; pin it directly.
  const actual = parseFloat(view.getComputedStyle(doc.body).fontSize)
  if (Math.abs(actual - fontSize) > 0.5)
    style.textContent += ` body { font-size: ${fontSize}px !important; }`
}

const classified = new WeakSet<Element>()

/**
 * Decides, per image, whether a dark theme should show it inverted. Line
 * art and screenshots on a white or transparent ground read best inverted
 * along with the text; photographs must not be.
 */
export function classifyImages(doc: Document): void {
  const images = doc.querySelectorAll<HTMLImageElement | SVGImageElement>('img, svg image')
  for (const image of images) {
    if (classified.has(image)) continue
    classified.add(image)
    const src =
      image instanceof (doc.defaultView as typeof globalThis).HTMLImageElement
        ? image.currentSrc || image.src
        : image.getAttribute('href') || image.getAttribute('xlink:href')
    // (remote images are not loaded at all, so there is nothing to judge)
    if (!src || !/^(blob|book|data):/i.test(src)) continue
    void isLightImage(src).then(light => {
      if (light) image.setAttribute('data-bv-inverted', '')
    })
  }
}

const lightCache = new Map<string, Promise<boolean>>()

function isLightImage(src: string): Promise<boolean> {
  let result = lightCache.get(src)
  if (!result) {
    result = analyze(src).catch(() => false)
    lightCache.set(src, result)
    if (lightCache.size > 2000) lightCache.delete(lightCache.keys().next().value!)
  }
  return result
}

async function analyze(src: string): Promise<boolean> {
  if (/^data:image\/svg|\.svg([?#]|$)/i.test(src)) return true
  const response = await fetch(src)
  const blob = await response.blob()
  if (blob.type === 'image/svg+xml') return true
  const bitmap = await createImageBitmap(blob, { resizeWidth: 48, resizeHeight: 48 })
  const canvas = new OffscreenCanvas(48, 48)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const { data } = context.getImageData(0, 0, 48, 48)
  let light = 0
  let transparent = 0
  let saturated = 0
  const total = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
    if (a < 40) {
      transparent++
      continue
    }
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (0.2126 * r + 0.7152 * g + 0.0722 * b > 225) light++
    if (max - min > 60) saturated++
  }
  // Mostly paper-white or see-through, and not a colourful picture.
  return (light + transparent) / total > 0.55 && saturated / total < 0.35
}
