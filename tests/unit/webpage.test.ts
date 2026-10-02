// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { preparePage } from '../../src/renderer/engines/webpage'

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')
const BASE = 'book://b1/guide/page.html'

const MDBOOK = `<!DOCTYPE html><html lang="en" class="navy sidebar-visible"><head>
  <title>Page - Book</title>
  <link rel="stylesheet" href="css/general.css">
  <link rel="stylesheet" href="tomorrow-night.css">
  <link rel="icon" href="favicon.svg">
  <script>var path_to_root = "";</script>
  </head><body onload="boot()">
  <nav id="sidebar"><ol class="chapter"><li><a href="other.html">Other</a></li></ol></nav>
  <div id="page-wrapper"><div class="page">
    <div id="menu-bar"><button id="sidebar-toggle">menu</button></div>
    <div id="content" class="content"><main>
      <h1 id="title"><a class="header" href="#title">A Title</a></h1>
      <p onclick="track()">Some <em>text</em>.</p>
      <pre><code class="language-rust"><span class="boring">fn main() {
</span>let x = 5;
<span class="boring">}</span></code></pre>
      <script>evil()</script>
    </main>
    <nav class="nav-wrapper"><a rel="next" href="next.html">next</a></nav>
    </div>
  </div></div>
  <script src="book.js"></script>
  </body></html>`

describe('preparing a web page for reading', () => {
  const html = preparePage(MDBOOK, BASE, 'mdbook', (code, language) =>
    language === 'rust' ? `<span class="hljs-keyword">${code.trim()}</span>` : null,
  )
  const doc = parse(html)

  it('keeps the content and drops the site chrome', () => {
    expect(doc.querySelector('main h1')?.textContent).toBe('A Title')
    expect(doc.querySelector('#sidebar')).toBeNull()
    expect(doc.querySelector('#menu-bar')).toBeNull()
    expect(doc.querySelector('.nav-wrapper')).toBeNull()
    expect(doc.querySelector('main')?.hasAttribute('data-bv-content')).toBe(true)
    expect(doc.querySelector('#content')?.hasAttribute('data-bv-chain')).toBe(true)
  })

  it('removes every way of running script', () => {
    expect(doc.querySelector('script')).toBeNull()
    expect(html).not.toContain('evil()')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('onload')
    expect(doc.querySelector('button')).toBeNull()
  })

  it('resolves resources against the original page', () => {
    expect(doc.querySelector('base')?.getAttribute('href')).toBe(BASE)
    expect(doc.querySelector('link[href="css/general.css"]')).not.toBeNull()
    expect(doc.querySelector('link[rel="icon"]')).toBeNull()
  })

  it('pins mdBook to its light theme and one code theme', () => {
    expect(doc.documentElement.classList.contains('light')).toBe(true)
    expect(doc.documentElement.classList.contains('navy')).toBe(false)
    expect(doc.querySelector('link[href*="tomorrow-night"]')).toBeNull()
  })

  it('highlights code, without the lines mdBook hides', () => {
    const code = doc.querySelector('pre > code')!
    expect(code.classList.contains('hljs')).toBe(true)
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('let x = 5;')
    expect(code.textContent).not.toContain('fn main')
  })

  it('is stable: preparing gives a document that parses back identically', () => {
    expect('<!DOCTYPE html>' + parse(html).documentElement.outerHTML).toBe(html)
  })
})

describe('content detection', () => {
  it('finds the article of a Sphinx page and records MathJax macros', () => {
    const page = `<html><head>
      <script>window.MathJax = {"tex": {"macros": {"red": ["\\\\color{red}{#1}", 1]}}, "options": {"processHtmlClass": "math"}}</script>
      </head><body>
      <div class="bd-sidebar-primary"><nav class="bd-links"><ul><li><a href="a.html">A</a></li></ul></nav></div>
      <main id="main-content"><article class="bd-article"><h1>Signals</h1>
        <p>Energy <span class="math">\\(E\\)</span></p>
        <script type="math/tex; mode=display">a^2 + b^2</script>
      </article>
      <footer class="prev-next-footer"><a href="b.html">Next</a></footer></main>
      </body></html>`
    const doc = parse(preparePage(page, BASE, 'sphinx'))
    expect(doc.querySelector('.bd-links')).toBeNull()
    expect(doc.querySelector('.prev-next-footer')).toBeNull()
    expect(doc.querySelector('article h1')?.textContent).toBe('Signals')
    const macros = JSON.parse(doc.querySelector('meta[name="bv-math-macros"]')!.getAttribute('content')!)
    expect(macros.red).toEqual(['\\color{red}{#1}', 1])
    // MathJax 2 style formula scripts become delimited text for our renderer
    expect(doc.querySelector('article')!.textContent).toContain('\\[a^2 + b^2\\]')
  })

  it('falls back to the whole body when nothing looks like the main content', () => {
    const doc = parse(preparePage('<html><body><p>Just a paragraph.</p><div class="content">x</div></body></html>', BASE, 'generic'))
    expect(doc.body.textContent).toContain('Just a paragraph.')
  })
})

describe('pages wrapped in a form', () => {
  it('keeps the content', () => {
    const page = `<html><body><form action="/x"><div id="content"><main><h1>Title</h1><p>Body text.</p>
      <input type="text" name="q"><button>Go</button></main></div></form></body></html>`
    const doc = parse(preparePage(page, BASE, 'mdbook'))
    expect(doc.querySelector('main h1')?.textContent).toBe('Title')
    expect(doc.body.textContent).toContain('Body text.')
    expect(doc.querySelector('input, button')).toBeNull()
  })
})
