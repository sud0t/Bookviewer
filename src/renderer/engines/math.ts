/**
 * Renders TeX math left in a book's text. Sites built with Sphinx, Jupyter
 * Book or mdBook leave formulas as `\( ... \)` and `\[ ... \]` for MathJax to
 * render in the browser; saved or converted to EPUB, the scripts are gone and
 * readers show the raw source. We run MathJax ourselves (in the app, never in
 * the book's frame) and put SVG next to the source.
 *
 * The source text stays in the document, hidden, and the SVG is marked as
 * ours (see cfi.ts), so text offsets and CFIs are the same with and without
 * rendering.
 */
import { IGNORE, SKIP } from './cfi'

interface MathJaxApi {
  tex2svgPromise(tex: string, options: { display: boolean }): Promise<HTMLElement>
  svgStylesheet(): HTMLStyleElement
  texReset(): void
  startup: { defaultReady(): void; promise: Promise<void> }
}

declare global {
  interface Window {
    MathJax?: unknown
  }
}

const SKIPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'pre',
  'code',
  'kbd',
  'samp',
  'tt',
  'textarea',
  'math',
  'svg',
])

const ENVIRONMENTS = 'equation|align|gather|multline|eqnarray|alignat|flalign'
const PATTERN = new RegExp(
  [
    String.raw`\\\(([\s\S]+?)\\\)`,
    String.raw`\\\[([\s\S]+?)\\\]`,
    String.raw`\$\$([\s\S]+?)\$\$`,
    String.raw`(\\begin\{(${ENVIRONMENTS})(\*?)\}[\s\S]+?\\end\{\5\6\})`,
  ].join('|'),
  'g',
)
const QUICK = /\\\(|\\\[|\$\$|\\begin\{/

/** Colour names that books commonly turn into macros: \red{x}, \blue{x}, ... */
const COLORS = [
  'red',
  'blue',
  'green',
  'purple',
  'orange',
  'cyan',
  'magenta',
  'yellow',
  'gray',
  'grey',
  'brown',
  'pink',
  'teal',
  'violet',
  'darkblue',
  'darkred',
  'darkgreen',
  'darkorange',
  'lightblue',
]

type Macros = Record<string, string | [string, number]>

let mathjax: Promise<MathJaxApi> | null = null

function loadMathJax(): Promise<MathJaxApi> {
  mathjax ??= new Promise<MathJaxApi>((resolve, reject) => {
    const base = new URL('./mathjax/', document.baseURI).href
    const macros: Macros = {}
    for (const color of COLORS) macros[color] = [`{\\color{${color}}{#1}}`, 1]
    window.MathJax = {
      startup: {
        typeset: false,
        ready() {
          const api = window.MathJax as MathJaxApi
          api.startup.defaultReady()
          void api.startup.promise.then(() => resolve(api))
        },
      },
      options: { enableMenu: false, enableAssistiveMml: false },
      tex: { tags: 'ams', macros },
      // every formula carries its own glyphs, so it can live in any document
      svg: { fontCache: 'none' },
    }
    const script = document.createElement('script')
    script.src = base + 'tex-svg.js'
    script.onerror = () => {
      mathjax = null
      reject(new Error('MathJax could not be loaded'))
    }
    document.head.append(script)
  })
  return mathjax
}

export function hasMath(doc: Document): boolean {
  return QUICK.test(doc.body?.textContent ?? '')
}

/** `\( and \)` in prose about regular expressions is not a formula. */
const plausibleInline = (tex: string): boolean =>
  /[\\^_=+<>|{}]|\d/.test(tex) || tex.trim().length <= 2

export interface Piece {
  text: string
  tex?: string
  display?: boolean
}

/** Cuts a text node's content into plain text and formulas. Null if it has none. */
export function splitMath(text: string): Piece[] | null {
  const pieces: Piece[] = []
  let last = 0
  let found = false
  PATTERN.lastIndex = 0
  for (let match = PATTERN.exec(text); match; match = PATTERN.exec(text)) {
    const inline = match[1]
    if (inline != null && !plausibleInline(inline)) continue
    const tex = inline ?? match[2] ?? match[3] ?? match[4]
    if (!tex.trim()) continue
    if (match.index > last) pieces.push({ text: text.slice(last, match.index) })
    pieces.push({ text: match[0], tex, display: inline == null })
    last = match.index + match[0].length
    found = true
  }
  if (!found) return null
  if (last < text.length) pieces.push({ text: text.slice(last) })
  return pieces
}

const definitions = (macros: Macros): string =>
  Object.entries(macros)
    .filter(([name]) => /^[A-Za-z]+$/.test(name))
    .map(([name, value]) => {
      const [body, args] = Array.isArray(value) ? value : [value, 0]
      return `\\newcommand{\\${name}}${args ? `[${args}]` : ''}{${body}}`
    })
    .join('\n')

/** Macros a site configured for its MathJax, as recorded by `preparePage`. */
function declaredMacros(doc: Document): Macros | null {
  const content = doc.querySelector('meta[name="bv-math-macros"]')?.getAttribute('content')
  if (!content) return null
  try {
    return JSON.parse(content) as Macros
  } catch {
    return null
  }
}

// Formula numbering and \label state are global to MathJax: one document at a time.
let queue: Promise<unknown> = Promise.resolve()

const started = new WeakMap<Document, Promise<boolean>>()

/**
 * Renders the math in a live document. Resolves to whether anything changed;
 * asking again for the same document returns the same (possibly pending) result.
 */
export function typesetMath(doc: Document): Promise<boolean> {
  const existing = started.get(doc)
  if (existing) return existing
  if (!hasMath(doc)) return Promise.resolve(false)
  const run = queue.then(() => typeset(doc))
  queue = run.catch(() => {})
  const result = run.catch(error => {
    console.warn('Rendering math failed:', error)
    return false
  })
  started.set(doc, result)
  return result
}

/** Resolves once any math rendering under way for the document has finished. */
export function mathSettled(doc: Document): Promise<unknown> {
  return started.get(doc) ?? Promise.resolve()
}

async function typeset(doc: Document): Promise<boolean> {
  const walker = doc.createTreeWalker(doc.body, 0x1 | 0x4, {
    acceptNode(node) {
      if (node.nodeType !== 1) return 1
      const element = node as Element
      if (SKIPPED.has(element.localName)) return 2
      if (element.hasAttribute(IGNORE) || element.hasAttribute(SKIP)) return 2
      return 3
    },
  })
  const jobs: { node: Text; pieces: Piece[] }[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    if (!QUICK.test(text)) continue
    const pieces = splitMath(text)
    if (pieces) jobs.push({ node: node as Text, pieces })
  }
  if (!jobs.length) return false

  const api = await loadMathJax()
  api.texReset()
  const macros = declaredMacros(doc)
  if (macros) await api.tex2svgPromise(definitions(macros), { display: false }).catch(() => {})

  // Render everything first, then touch the document once per text node.
  const rendered = new Map<Piece, Node>()
  for (const { pieces } of jobs) {
    for (const piece of pieces) {
      if (piece.tex == null) continue
      try {
        const container = await api.tex2svgPromise(piece.tex, { display: !!piece.display })
        container.setAttribute(IGNORE, '')
        container.classList.add('bv-math')
        rendered.set(piece, doc.importNode(container, true))
      } catch {
        // leave this formula as its source text
      }
    }
  }
  // The document may be gone by now, or math may have been switched off
  // (removeMath) while MathJax was working.
  if (!doc.defaultView || !started.has(doc)) return false

  if (!doc.querySelector('style[data-bv-math]')) {
    const style = doc.createElement('style')
    style.setAttribute('data-bv-math', '')
    style.textContent =
      api.svgStylesheet().textContent +
      '\n.bv-tex { display: none !important; }' +
      '\nmjx-container.bv-math[display="true"] { overflow-x: auto; overflow-y: hidden; max-width: 100%; }'
    ;(doc.head ?? doc.documentElement).append(style)
  }
  for (const { node, pieces } of jobs) {
    if (!node.isConnected) continue
    const fragment = doc.createDocumentFragment()
    for (const piece of pieces) {
      const math = rendered.get(piece)
      if (!math) {
        fragment.append(doc.createTextNode(piece.text))
        continue
      }
      const source = doc.createElement('span')
      source.className = 'bv-tex'
      source.setAttribute(SKIP, '')
      source.append(doc.createTextNode(piece.text))
      fragment.append(source, math)
    }
    node.replaceWith(fragment)
  }
  return true
}

/** Puts a document back the way it was before `typesetMath`. */
export function removeMath(doc: Document): void {
  if (!started.delete(doc)) return
  for (const math of doc.querySelectorAll('.bv-math')) math.remove()
  for (const source of doc.querySelectorAll('.bv-tex')) {
    const parent = source.parentNode
    source.replaceWith(...source.childNodes)
    parent?.normalize()
  }
}
