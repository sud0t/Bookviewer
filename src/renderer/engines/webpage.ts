/**
 * Turns a saved web page into something to read: only the content element
 * (and the ancestors that give its styles their context) survives; site
 * chrome, scripts and anything interactive are dropped.
 */
import type { WebGenerator } from '@shared/types'

/** Where each generator keeps the page's real content. First match wins. */
const CONTENT_SELECTORS: Record<WebGenerator, string[]> = {
  mdbook: ['#content main', '#mdbook-content main', 'main'],
  sphinx: [
    'article.bd-article',
    'main#main-content .bd-article',
    '[itemprop="articleBody"]',
    'article[role="main"]',
    'div.body[role="main"]',
    '[role="main"]',
    'div.body',
    'div.document',
  ],
  mkdocs: ['article.md-content__inner', '.md-content', '[role="main"]', '#mkdocs-content', 'div.col-md-9'],
  docusaurus: ['.theme-doc-markdown', 'article', 'main'],
  gitbook: ['section.markdown-section', '.page-inner section', '.book-body .page-inner'],
  generic: [],
  single: [],
}

const GENERIC_CONTENT = [
  'main article',
  'article',
  'main',
  '[role="main"]',
  '#main-content',
  '#content',
  '.content',
  '#main',
  '.main',
  '.post',
  '.entry-content',
  '.document',
]

/** Things inside the content area that only make sense on the live site. */
const JUNK = [
  'script',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'button',
  'input',
  'select',
  'textarea',
  'dialog',
  // prev / next chapter links
  'nav.nav-wrapper',
  '.nav-chapters',
  '.prev-next-area',
  '.prev-next-footer',
  '.md-footer',
  '.pagination-nav',
  '.rst-footer-buttons',
  '.related-pages',
  // per-page chrome
  '.bd-header-article',
  '.bd-footer-article',
  '.header-article-items',
  '.toc-drawer',
  '.breadcrumbs',
  '.theme-doc-breadcrumbs',
  '.theme-doc-footer',
  '.md-source-file',
  '.edit-this-page',
  '[role="search"]',
].join(', ')

const HEAD_JUNK =
  'script, noscript, template, base, meta[http-equiv], link:not([rel~="stylesheet"])'

const ISOLATE_CSS = `
  [data-bv-chain] {
    display: block !important;
    position: static !important;
    float: none !important;
    inset: auto !important;
    width: auto !important;
    max-width: none !important;
    min-width: 0 !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    transform: none !important;
    overflow: visible !important;
    background: none !important;
    box-shadow: none !important;
  }
  [data-bv-content] {
    display: block !important;
    position: static !important;
    float: none !important;
    width: auto !important;
    max-width: none !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    background: none !important;
    box-shadow: none !important;
  }
  a.headerlink, a.header-anchor, a.hash-link, .anchor-link { display: none !important; }
  table { max-width: 100%; }
`

/** Themes that follow a class or attribute: pin them to their light variant. */
function forceLightTheme(doc: Document, generator: WebGenerator): void {
  const html = doc.documentElement
  if (generator === 'mdbook') {
    html.classList.remove('coal', 'navy', 'ayu', 'rust', 'sidebar-visible', 'js')
    html.classList.add('light', 'no-js')
  }
  for (const element of [html, doc.body]) {
    if (!element) continue
    if (element.hasAttribute('data-theme')) element.setAttribute('data-theme', 'light')
    if (element.hasAttribute('data-mode')) element.setAttribute('data-mode', 'light')
    if (element.hasAttribute('data-bs-theme')) element.setAttribute('data-bs-theme', 'light')
    if (element.hasAttribute('data-md-color-scheme'))
      element.setAttribute('data-md-color-scheme', 'default')
  }
}

function findContent(doc: Document, generator: WebGenerator): Element {
  const body = doc.body
  const bodyText = body.textContent?.trim().length ?? 0
  for (const selector of [...CONTENT_SELECTORS[generator], ...GENERIC_CONTENT]) {
    let best: Element | null = null
    for (const element of body.querySelectorAll(selector)) {
      const length = element.textContent?.trim().length ?? 0
      if (!best || length > (best.textContent?.trim().length ?? 0)) best = element
    }
    if (!best) continue
    const length = best.textContent?.trim().length ?? 0
    // A known generator's selector is trusted; a generic guess has to hold
    // a good share of the page, or it is probably a sidebar or a teaser.
    const trusted = CONTENT_SELECTORS[generator].includes(selector)
    if (trusted ? length > 0 || best.querySelector('img, svg') : length >= bodyText * 0.4) return best
  }
  return body
}

/** Highlights source code; returns HTML, or null for an unknown language. */
export type Highlighter = (code: string, language: string) => string | null

/** A plain colour scheme for highlighted code, for sites that bring none of their own. */
const HIGHLIGHT_CSS = `
  .hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag { color: #b3261e; }
  .hljs-string, .hljs-regexp, .hljs-addition, .hljs-attribute, .hljs-meta .hljs-string { color: #0a5d2a; }
  .hljs-number, .hljs-symbol, .hljs-bullet, .hljs-variable, .hljs-template-variable { color: #0550ae; }
  .hljs-title, .hljs-section, .hljs-name, .hljs-selector-id, .hljs-selector-class { color: #6f42c1; }
  .hljs-type, .hljs-built_in, .hljs-class .hljs-title { color: #953800; }
  .hljs-meta, .hljs-deletion { color: #8250df; }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: bold; }
`

/**
 * The macros a page configured for MathJax. Sphinx writes the configuration
 * as JSON (`window.MathJax = {"tex": {"macros": {...}}}`), which is all we
 * try to understand.
 */
function mathMacros(doc: Document): string | null {
  for (const script of doc.querySelectorAll('script:not([src])')) {
    const source = script.textContent ?? ''
    if (!/MathJax/.test(source)) continue
    const assignment = source.search(/MathJax\s*=|Hub\.Config\s*\(/)
    const start = assignment < 0 ? -1 : source.indexOf('{', assignment)
    if (start < 0) continue
    // Find the matching brace of the configuration object.
    let depth = 0
    let end = -1
    let inString: string | null = null
    for (let i = start; i < source.length; i++) {
      const char = source[i]
      if (inString) {
        if (char === '\\') i++
        else if (char === inString) inString = null
      } else if (char === '"' || char === "'") inString = char
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        end = i
        break
      }
    }
    if (end < 0) continue
    try {
      const config = JSON.parse(source.slice(start, end + 1)) as {
        tex?: { macros?: unknown }
        TeX?: { Macros?: unknown }
      }
      const macros = config.tex?.macros ?? config.TeX?.Macros
      if (macros && typeof macros === 'object') return JSON.stringify(macros)
    } catch {
      // a configuration written as code rather than data
    }
  }
  return null
}

/** Applies syntax highlighting where the site would have done so with a script. */
function highlightCode(doc: Document, generator: WebGenerator, highlight: Highlighter): void {
  for (const code of doc.body.querySelectorAll('pre > code')) {
    // mdBook marks lines that are compiled but not shown.
    if (generator === 'mdbook') for (const boring of code.querySelectorAll('.boring')) boring.remove()
    if (code.children.length) continue
    const language = /\b(?:lang|language)-([\w+#-]+)/.exec(code.className)?.[1]
    if (!language || /^(text|plain|plaintext|console|none)$/.test(language)) continue
    const html = highlight(code.textContent ?? '', language)
    if (html == null) continue
    code.innerHTML = html
    code.classList.add('hljs')
  }
}

/**
 * Rewrites a page for reading: only the content element (and the ancestors
 * that give its styles their context) survives; everything resolves against
 * the page's own URL through a <base>.
 */
export function preparePage(
  html: string,
  baseUrl: string,
  generator: WebGenerator,
  highlight?: Highlighter,
): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc.body) return '<!DOCTYPE html><html><head></head><body></body></html>'
  const macros = mathMacros(doc)
  // MathJax 2 pages may carry formulas as <script type="math/tex">.
  for (const script of doc.body.querySelectorAll('script[type^="math/tex"]')) {
    const display = /mode\s*=\s*display/.test(script.getAttribute('type') ?? '')
    const tex = script.textContent ?? ''
    script.replaceWith(doc.createTextNode(display ? `\\[${tex}\\]` : `\\(${tex}\\)`))
  }
  for (const element of doc.head.querySelectorAll(HEAD_JUNK)) element.remove()
  // mdBook loads every code theme and lets its script disable all but one.
  if (generator === 'mdbook')
    for (const link of doc.head.querySelectorAll('link[href*="tomorrow-night"], link[href*="ayu-highlight"]'))
      link.remove()
  forceLightTheme(doc, generator)

  const content = findContent(doc, generator)
  if (content !== doc.body) {
    content.setAttribute('data-bv-content', '')
    for (let node: Element = content; node.parentElement && node !== doc.body; ) {
      const parent: Element = node.parentElement
      for (const sibling of [...parent.children]) {
        if (sibling === node) continue
        const name = sibling.localName
        // Stylesheets can live in the body too; keep those.
        if (name === 'style' || (name === 'link' && /stylesheet/i.test(sibling.getAttribute('rel') ?? '')))
          continue
        sibling.remove()
      }
      if (parent !== doc.body) parent.setAttribute('data-bv-chain', '')
      node = parent
    }
  }
  // (never an ancestor of the content: some pages wrap everything in a
  // <form> or a search landmark)
  for (const element of doc.body.querySelectorAll(JUNK))
    if (!element.hasAttribute('data-bv-chain') && !element.hasAttribute('data-bv-content'))
      element.remove()
  // Inline handlers are dead weight (and blocked anyway).
  for (const element of doc.querySelectorAll('*'))
    for (const attribute of [...element.attributes])
      if (attribute.name.startsWith('on')) element.removeAttribute(attribute.name)

  if (highlight) highlightCode(doc, generator, highlight)

  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const base = doc.createElement('base')
  base.setAttribute('href', baseUrl)
  // First in the head, so that the site's own code theme wins if it has one.
  const fallback = doc.createElement('style')
  fallback.textContent = HIGHLIGHT_CSS
  doc.head.prepend(charset, base, fallback)
  if (macros) {
    const meta = doc.createElement('meta')
    meta.setAttribute('name', 'bv-math-macros')
    meta.setAttribute('content', macros)
    doc.head.append(meta)
  }
  const style = doc.createElement('style')
  style.textContent = ISOLATE_CSS
  doc.head.append(style)
  return '<!DOCTYPE html>' + doc.documentElement.outerHTML
}
