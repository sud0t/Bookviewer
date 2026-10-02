// @vitest-environment jsdom
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FoliateTocItem } from 'foliate-js/types'
import { buildWebBook } from '../../src/main/webbook'
import { isSelfLink, nestNumbered, tocEntryOf, tocPlaces } from '../../src/renderer/engines/epub'
import { makeWebBook } from '../../src/renderer/engines/webbook'
import type { TocNode, WebBookManifest } from '../../src/shared/types'

const tree = (nodes: TocNode[]): unknown[] =>
  nodes.map(node => (node.children.length ? [node.label, tree(node.children)] : node.label))
const subtree = (items: FoliateTocItem[]): unknown[] =>
  items.map(item => (item.subitems?.length ? [item.label, subtree(item.subitems)] : item.label))

/**
 * The start of toc.html from the mdBook copy of The Rust Programming Language
 * that rustup installs, as mdBook writes it today: links wrapped in
 * span.chapter-link-wrapper, the sections' list inside the chapter's <li>,
 * and that <li> left unclosed before the next chapter.
 */
const item = (href: string, number: string, title: string) =>
  `<li class="chapter-item expanded "><span class="chapter-link-wrapper"><a href="${href}" target="_parent">${
    number ? `<strong aria-hidden="true">${number}</strong> ` : ''
  }${title}</a></span>`
const RUST_TOC =
  '<ol class="chapter">' +
  item('title-page.html', '', 'The Rust Programming Language') + '</li>' +
  item('foreword.html', '', 'Foreword') + '</li>' +
  item('ch00-00-introduction.html', '', 'Introduction') + '</li>' +
  item('ch01-00-getting-started.html', '1.', 'Getting Started') +
  '<ol class="section">' +
  item('ch01-01-installation.html', '1.1.', 'Installation') + '</li>' +
  item('ch01-02-hello-world.html', '1.2.', 'Hello, World!') + '</li>' +
  item('ch01-03-hello-cargo.html', '1.3.', 'Hello, Cargo!') + '</li>' +
  '</ol>' +
  item('ch02-00-guessing-game-tutorial.html', '2.', 'Programming a Guessing Game') + '</li>' +
  item('ch03-00-common-programming-concepts.html', '3.', 'Common Programming Concepts') +
  '<ol class="section">' +
  item('ch03-01-variables-and-mutability.html', '3.1.', 'Variables and Mutability') + '</li>' +
  item('ch03-02-data-types.html', '3.2.', 'Data Types') + '</li>' +
  '</ol></li></ol>'

const PAGES = [
  'title-page.html',
  'foreword.html',
  'ch00-00-introduction.html',
  'ch01-00-getting-started.html',
  'ch01-01-installation.html',
  'ch01-02-hello-world.html',
  'ch01-03-hello-cargo.html',
  'ch02-00-guessing-game-tutorial.html',
  'ch03-00-common-programming-concepts.html',
  'ch03-01-variables-and-mutability.html',
  'ch03-02-data-types.html',
]

const NESTED = [
  'The Rust Programming Language',
  'Foreword',
  'Introduction',
  ['1. Getting Started', ['1.1. Installation', '1.2. Hello, World!', '1.3. Hello, Cargo!']],
  '2. Programming a Guessing Game',
  ['3. Common Programming Concepts', ['3.1. Variables and Mutability', '3.2. Data Types']],
]

describe('the contents of a saved mdBook', () => {
  let root: string
  let manifest: WebBookManifest

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bookviewer-toc-'))
    const write = async (path: string, content: string) => {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    }
    const page = (title: string) =>
      `<!DOCTYPE HTML><html lang="en"><head><!-- Book generated using mdBook --><title>${title} - The Rust Programming Language</title></head>` +
      `<body><div id="content" class="content"><main><h1 id="t"><a class="header" href="#t">${title}</a></h1></main></div></body></html>`
    for (const name of PAGES) await write(name, page(name))
    await write('index.html', page('The Rust Programming Language'))
    await write('toc-f266997e.js', '')
    await write(
      'toc.html',
      `<!DOCTYPE HTML><html lang="en" class="light" dir="ltr"><head><!-- sidebar iframe generated using mdBook --><meta charset="UTF-8"></head><body class="sidebar-iframe-inner">${RUST_TOC}</body></html>`,
    )
    manifest = await buildWebBook(root, 'mdbook', 'index.html')
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  it('keeps sections inside their numbered chapters', () => {
    expect(tree(manifest.toc)).toEqual(NESTED)
    expect(manifest.toc[3].children).toHaveLength(3)
    expect(manifest.toc[3].children[0].href).toBe('ch01-01-installation.html')
  })

  it('reads the pages in the order of the contents', () => {
    expect(manifest.pages.map(page => page.href)).toEqual(PAGES)
  })

  it('hands the same nesting to the reader', () => {
    const book = makeWebBook(1, manifest)
    expect(subtree(book.toc ?? [])).toEqual(NESTED)
    // a list that is nested already is not rearranged
    expect(nestNumbered(book.toc ?? [])).toBe(book.toc)
  })

  it('knows which entry each page belongs to', async () => {
    const book = makeWebBook(1, manifest)
    const places = await tocPlaces(
      book.toc ?? [],
      book.sections.map(section => section.id),
      book.splitTOCHref!.bind(book),
    )
    expect(places.map(place => place.section)).toEqual(PAGES.map((_, index) => index))
    expect(tocEntryOf(places, 5)?.label).toBe('1.2. Hello, World!')
    expect(tocEntryOf(places, 8)?.label).toBe('3. Common Programming Concepts')
  })
})

describe('a contents list with no nesting of its own', () => {
  // the nav of ~/Books/The Rust Programming Language.epub: one flat <ol>
  const flat = (labels: string[]): FoliateTocItem[] =>
    labels.map((label, index) => ({ label, href: `ch${String(index + 1).padStart(3, '0')}.xhtml` }))
  const RUST_EPUB = [
    'The Rust Programming Language',
    'Foreword',
    'Introduction',
    '1. Getting Started',
    '1.1. Installation',
    '1.2. Hello, World!',
    '1.3. Hello, Cargo!',
    '2. Programming a Guessing Game',
    '3. Common Programming Concepts',
    '3.1. Variables and Mutability',
    '3.2. Data Types',
  ]

  it('is nested by its numbering', () => {
    const nested = nestNumbered(flat(RUST_EPUB))
    expect(subtree(nested)).toEqual(NESTED)
    expect(nested[3].subitems).toHaveLength(3)
    // every entry still leads where it did
    expect(nested[3].subitems![1].href).toBe('ch006.xhtml')
  })

  it('does not touch the list it was given', () => {
    const toc = flat(RUST_EPUB)
    nestNumbered(toc)
    expect(toc).toHaveLength(RUST_EPUB.length)
    expect(toc.every(entry => !entry.subitems)).toBe(true)
  })

  it('nests to any depth, and understands numbers without the final dot', () => {
    const nested = nestNumbered(flat(['1 Basics', '1.1 Types', '1.1.1 Integers', '1.1.2 Floats', '1.2 Control', '2 More']))
    expect(subtree(nested)).toEqual([
      ['1 Basics', [['1.1 Types', ['1.1.1 Integers', '1.1.2 Floats']], '1.2 Control']],
      '2 More',
    ])
  })

  it('leaves lists alone that give no reason to nest', () => {
    const plain = flat(['Preface', 'Chapter One', 'Chapter Two'])
    expect(nestNumbered(plain)).toBe(plain)
    const numbered = flat(['1. One', '2. Two', '10 Downing Street', '1984'])
    expect(nestNumbered(numbered)).toBe(numbered)
    // a section whose chapter is not in the list stays where it is
    const orphans = flat(['Introduction', '2.1 Orphan', '2.2 Orphan'])
    expect(nestNumbered(orphans)).toBe(orphans)
  })

  it('ends a chapter at an entry without a number', () => {
    const nested = nestNumbered(flat(['3. Chapter', '3.1 A', 'Interlude', '3.2 B']))
    expect(subtree(nested)).toEqual([['3. Chapter', ['3.1 A']], 'Interlude', '3.2 B'])
  })
})

describe('the contents entry a section belongs to', () => {
  const toc: FoliateTocItem[] = [
    { label: 'Cover', href: 'cover.xhtml' },
    {
      label: 'Chapter 1',
      href: 'c1.xhtml',
      subitems: [
        { label: '1.1', href: 'c1.xhtml#a' },
        { label: '1.2', href: 'c1.xhtml#b' },
      ],
    },
    { label: 'Part two', href: null, subitems: [{ label: 'Chapter 2', href: 'c2.xhtml#top' }] },
    { label: 'Elsewhere', href: 'not-in-the-book.xhtml' },
  ]
  const ids = ['cover.xhtml', 'titlepage.xhtml', 'c1.xhtml', 'c1-continued.xhtml', 'c2.xhtml']
  const split = (href: string) => {
    const [path, fragment] = href.split('#')
    return [path, fragment]
  }

  it('lists the entries that lead somewhere, with their sections', async () => {
    const places = await tocPlaces(toc, ids, split)
    expect(places.map(place => [place.item.label, place.section, place.fragment])).toEqual([
      ['Cover', 0, undefined],
      ['Chapter 1', 2, undefined],
      ['1.1', 2, 'a'],
      ['1.2', 2, 'b'],
      ['Chapter 2', 4, 'top'],
    ])
  })

  it('is the first entry that starts in the section', async () => {
    const places = await tocPlaces(toc, ids, split)
    expect(tocEntryOf(places, 0)?.label).toBe('Cover')
    expect(tocEntryOf(places, 2)?.label).toBe('Chapter 1')
    expect(tocEntryOf(places, 4)?.label).toBe('Chapter 2')
  })

  it('is the last entry before a section in which none starts', async () => {
    const places = await tocPlaces(toc, ids, split)
    expect(tocEntryOf(places, 1)?.label).toBe('Cover')
    expect(tocEntryOf(places, 3)?.label).toBe('1.2')
    expect(tocEntryOf([], 0)).toBeNull()
    expect(tocEntryOf(places.slice(1), 0)).toBeNull()
  })
})

describe('links that wrap a heading', () => {
  const doc = new DOMParser().parseFromString(
    `<body>
      <h2 id="hello-world"><a id="own" href="ch006.xhtml#hello-world">Hello, World!</a></h2>
      <h2 id="plain"><a id="hash" class="header" href="#plain">Plain</a></h2>
      <section id="sec"><h3><a id="section" href="#sec">Titled section</a></h3><p>Text</p></section>
      <h3><a id="named" href="#old-name"><span></span>Renamed</a><a name="old-name"></a></h3>
      <a id="around" class="header" href="#around"><h2>Wrapped the old mdBook way</h2></a>
      <a id="card" href="#plain"><h3>A card</h3><p>that leads to another heading</p></a>
      <h2 id="see"><a id="other" href="#plain">See the other heading</a></h2>
      <h2 id="away"><a id="page" href="other.xhtml">Another page</a></h2>
      <p id="para"><a id="body" href="#para">a link in the text</a></p>
      <h2><a id="dangling" href="#nowhere">Dangling</a></h2>
    </body>`,
    'text/html',
  )
  const self = (id: string) => isSelfLink(doc.getElementById(id)!)

  it('recognises a heading that links to itself', () => {
    expect(self('own')).toBe(true)
    expect(self('hash')).toBe(true)
    // ... to the section it is the title of, or to an anchor inside itself
    expect(self('section')).toBe(true)
    expect(self('named')).toBe(true)
    // ... or wraps the heading it points to
    expect(self('around')).toBe(true)
  })

  it('leaves real links alone, in headings and in the text', () => {
    expect(self('other')).toBe(false)
    expect(self('card')).toBe(false)
    expect(self('page')).toBe(false)
    expect(self('body')).toBe(false)
    expect(self('dangling')).toBe(false)
  })
})
