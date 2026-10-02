import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatOf, scanFolder } from '../../src/main/library'
import { resolveLink } from '../../src/main/webbook'
import type { TocNode } from '../../src/shared/types'

let root: string

async function write(path: string, content = ''): Promise<void> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

const page = (title: string, body: string, head = '') =>
  `<!DOCTYPE html><html lang="en"><head><title>${title}</title>${head}</head><body>${body}</body></html>`

const labels = (nodes: TocNode[]): unknown[] =>
  nodes.map(node => (node.children.length ? [node.label, labels(node.children)] : node.label))

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bookviewer-scan-'))

  // plain e-book files, one of them nested
  await write('Novel.epub', 'PK')
  await write('papers/Some_Paper.pdf', '%PDF-')
  await write('comics/Issue 1.cbz', 'PK')
  await write('notes.txt', 'not a book')
  await write('.hidden/Secret.epub', 'PK')

  // an mdBook: full table of contents in toc.html, index.html duplicates chapter 1
  const mdbook = (title: string) =>
    page(`${title} - The Example Book`, `<div id="content"><main><h1>${title}</h1></main></div>`, '<!-- Book generated using mdBook -->')
  await write('example-book/index.html', mdbook('Introduction'))
  await write('example-book/intro.html', mdbook('Introduction'))
  await write('example-book/ch01.html', mdbook('Getting Started'))
  await write('example-book/ch01-01.html', mdbook('Installation'))
  await write('example-book/ch02.html', mdbook('Going Further'))
  await write('example-book/book.js', '')
  await write(
    'example-book/toc.html',
    page('toc', `<ol class="chapter">
       <li class="chapter-item"><a href="intro.html" target="_parent">Introduction</a></li>
       <li class="chapter-item"><a href="ch01.html"><strong>1.</strong> Getting Started</a>
         <ol class="section"><li class="chapter-item"><a href="ch01-01.html"><strong>1.1.</strong> Installation</a></li></ol>
       </li>
       <li class="chapter-item"><a href="ch02.html"><strong>2.</strong> Going Further</a></li>
     </ol>`),
  )

  // a Sphinx site: the index sidebar only lists top-level pages; sub-pages
  // show up in the sidebar of their section, and "next" links give the order
  const sphinx = (title: string, sidebar: string, next: string | null) =>
    page(
      `${title} — Example Docs 1.0 documentation`,
      `<div class="wy-menu wy-menu-vertical"><ul>${sidebar}</ul></div>
       <div role="main"><h1>${title}<a class="headerlink" href="#x">¶</a></h1><p>Text.</p></div>`,
      next ? `<link rel="next" href="${next}">` : '',
    )
  const top =
    '<li class="toctree-l1"><a href="usage/index.html">Usage</a></li><li class="toctree-l1"><a href="faq.html">FAQ</a></li>'
  const inUsage = (prefix: string) =>
    `<li class="toctree-l1 current"><a href="${prefix}index.html">Usage</a><ul>
       <li class="toctree-l2"><a href="${prefix}install.html">Installing</a></li>
       <li class="toctree-l2"><a href="${prefix}config.html">Configuring</a></li></ul></li>
     <li class="toctree-l1"><a href="${prefix}../faq.html">FAQ</a></li>`
  await write('docs/index.html', sphinx('Welcome', top, 'usage/index.html'))
  await write('docs/usage/index.html', sphinx('Usage', inUsage(''), 'install.html'))
  await write('docs/usage/install.html', sphinx('Installing', inUsage(''), 'config.html'))
  await write('docs/usage/config.html', sphinx('Configuring', inUsage(''), '../faq.html'))
  await write('docs/faq.html', sphinx('FAQ', top.replace(/usage\//g, 'usage/'), null))
  await write('docs/objects.inv', '')
  await write('docs/_static/style.css', '')
  await write('docs/genindex.html', page('Index', '<p>index</p>'))

  // a hand-made book: an index page linking its chapters
  await write(
    'handmade/index.html',
    page('My Scraped Novel', '<h1>My Scraped Novel</h1><p><a href="one.html">Chapter One</a> <a href="two.html">Chapter Two</a> <a href="https://example.org/">elsewhere</a></p>'),
  )
  await write('handmade/one.html', page('Chapter One', '<p>1</p>'))
  await write('handmade/two.html', page('Chapter Two', '<p>2</p>'))

  // a single saved page with its resources folder
  await write(
    'Saved Article.html',
    page('An Article Worth Keeping', '<h1 id="top">An Article</h1><h2 id="part-1">Part 1</h2><h2 id="part-2">Part 2</h2>'),
  )
  await write('Saved Article_files/frame.html', page('ad', ''))
})

afterAll(() => rm(root, { recursive: true, force: true }))

describe('formats', () => {
  it('recognises book files by extension', () => {
    expect(formatOf('a.EPUB')).toBe('epub')
    expect(formatOf('a.azw3')).toBe('azw3')
    expect(formatOf('a.fb2.zip')).toBe('fbz')
    expect(formatOf('a.txt')).toBeNull()
    expect(formatOf('archive.zip')).toBeNull()
  })
})

describe('scanning a library folder', () => {
  it('finds each kind of book exactly once', async () => {
    const books = await scanFolder(root)
    const found = books.map(book => [book.path.slice(root.length + 1), book.format]).sort()
    expect(found).toEqual([
      ['Novel.epub', 'epub'],
      ['Saved Article.html', 'web'],
      ['comics/Issue 1.cbz', 'cbz'],
      ['docs', 'web'],
      ['example-book', 'web'],
      ['handmade', 'web'],
      ['papers/Some_Paper.pdf', 'pdf'],
    ])
    expect(books.find(book => book.path.endsWith('Some_Paper.pdf'))!.title).toBe('Some Paper')
  })

  it('reads an mdBook from its toc.html', async () => {
    const book = (await scanFolder(root)).find(b => b.path.endsWith('example-book'))!
    const manifest = book.manifest!
    expect(manifest.generator).toBe('mdbook')
    expect(manifest.title).toBe('The Example Book')
    expect(manifest.pages.map(p => p.href)).toEqual(['intro.html', 'ch01.html', 'ch01-01.html', 'ch02.html'])
    expect(labels(manifest.toc)).toEqual([
      'Introduction',
      ['1. Getting Started', ['1.1. Installation']],
      '2. Going Further',
    ])
  })

  it('walks a Sphinx site by its next links and grafts the nested contents', async () => {
    const book = (await scanFolder(root)).find(b => b.path.endsWith('/docs'))!
    const manifest = book.manifest!
    expect(manifest.generator).toBe('sphinx')
    expect(manifest.title).toBe('Example Docs 1.0')
    expect(manifest.language).toBe('en')
    expect(manifest.pages.map(p => p.href)).toEqual([
      'index.html',
      'usage/index.html',
      'usage/install.html',
      'usage/config.html',
      'faq.html',
    ])
    expect(labels(manifest.toc)).toEqual(['Welcome', ['Usage', ['Installing', 'Configuring']], 'FAQ'])
    expect(manifest.toc[1].children[0].href).toBe('usage/install.html')
  })

  it('treats a folder with an index page as a book', async () => {
    const book = (await scanFolder(root)).find(b => b.path.endsWith('handmade'))!
    expect(book.manifest!.generator).toBe('generic')
    expect(book.manifest!.title).toBe('My Scraped Novel')
    expect(book.manifest!.pages.map(p => p.href)).toEqual(['index.html', 'one.html', 'two.html'])
  })

  it('makes a table of contents from a single page\'s headings', async () => {
    const book = (await scanFolder(root)).find(b => b.path.endsWith('Saved Article.html'))!
    expect(book.manifest!.generator).toBe('single')
    expect(book.manifest!.title).toBe('An Article Worth Keeping')
    expect(labels(book.manifest!.toc)).toEqual([['An Article', ['Part 1', 'Part 2']]])
    expect(book.manifest!.toc[0].children[1].href).toBe('Saved Article.html#part-2')
  })

  it('does not re-read web books that have not changed', async () => {
    const first = await scanFolder(root)
    const known = new Map(
      first.filter(b => b.format === 'web').map(b => [b.path, { mtime: b.mtime, size: b.size }]),
    )
    const second = await scanFolder(root, known)
    expect(second.map(b => b.path).sort()).toEqual(first.map(b => b.path).sort())
    for (const book of second.filter(b => b.format === 'web')) {
      expect(book.manifest).toBeUndefined()
      expect(book.size).toBe(known.get(book.path)!.size)
    }
  })
})

describe('link resolution', () => {
  const pages = new Map([
    ['index.html', 1],
    ['guide/index.html', 1],
    ['guide/setup.html', 1],
    ['a b.html', 1],
  ])
  it('resolves relative links against the page they are on', () => {
    expect(resolveLink('setup.html#x', 'guide/index.html', pages)).toEqual({ path: 'guide/setup.html', hash: '#x' })
    expect(resolveLink('../index.html', 'guide/setup.html', pages)).toEqual({ path: 'index.html', hash: '' })
    expect(resolveLink('#top', 'guide/setup.html', pages)).toEqual({ path: 'guide/setup.html', hash: '#top' })
    expect(resolveLink('a%20b.html', 'index.html', pages)).toEqual({ path: 'a b.html', hash: '' })
  })
  it('understands directory-style URLs', () => {
    expect(resolveLink('guide/', 'index.html', pages)).toEqual({ path: 'guide/index.html', hash: '' })
    expect(resolveLink('guide/setup', 'index.html', pages)).toEqual({ path: 'guide/setup.html', hash: '' })
  })
  it('refuses links that leave the book', () => {
    expect(resolveLink('https://example.org/x.html', 'index.html', pages)).toBeNull()
    expect(resolveLink('//example.org/x.html', 'index.html', pages)).toBeNull()
    expect(resolveLink('../../etc/passwd', 'index.html', pages)).toBeNull()
    expect(resolveLink('/absolute.html', 'index.html', pages)).toBeNull()
    expect(resolveLink('missing.html', 'index.html', pages)).toBeNull()
    expect(resolveLink('mailto:a@b.c', 'index.html', pages)).toBeNull()
  })
})
