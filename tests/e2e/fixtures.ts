/** Builds a tiny library (an EPUB, a PDF and a saved mdBook-style site) to test against. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { crc32 } from 'node:zlib'

/** A ZIP archive with stored (uncompressed) entries: all an EPUB needs. */
function zip(files: [name: string, content: string][]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.from(content)
    const nameBytes = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const paragraphs = (topic: string, count: number): string =>
  Array.from(
    { length: count },
    (_, i) =>
      `<p>Paragraph ${i + 1} about ${topic}. The lighthouse keeper counted the ships as they passed, one after another, in the grey light before dawn.</p>`,
  ).join('\n')

const chapter = (title: string, body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>${title}</title></head>
<body><h1 id="top">${title}</h1>${body}</body></html>`

export function makeEpub(): Buffer {
  return zip([
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ],
    [
      'OEBPS/content.opf',
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="uid">urn:bookviewer:test</dc:identifier>
  <dc:title>The Test Lighthouse</dc:title><dc:creator>Ada Example</dc:creator><dc:language>en</dc:language>
  <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
</metadata>
<manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
</package>`,
    ],
    [
      'OEBPS/nav.xhtml',
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">Arrival</a></li>
  <li><a href="ch2.xhtml">The Storm</a></li>
  <li><a href="ch3.xhtml">Morning</a></li>
</ol></nav></body></html>`,
    ],
    ['OEBPS/ch1.xhtml', chapter('Arrival', paragraphs('arrival', 30))],
    [
      'OEBPS/ch2.xhtml',
      chapter(
        'The Storm',
        `<p>The barometer fell all afternoon; the formula \\(E = mc^2\\) was scratched on the wall.</p>` +
          paragraphs('the storm', 30),
      ),
    ],
    ['OEBPS/ch3.xhtml', chapter('Morning', paragraphs('morning', 30) + '<p>A zebrafish swam past.</p>')],
  ])
}

export function makePdf(pages: string[]): Buffer {
  const objects: string[] = []
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  const font = 3 + pages.length * 2
  pages.forEach((text, i) => {
    const stream = `BT /F1 20 Tf 72 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    )
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Title (A Test Paper) /Author (Bob Example) >> >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const mdbookPage = (title: string, body: string, next: string | null): string =>
  `<!DOCTYPE HTML><html lang="en" class="light sidebar-visible"><head>
<!-- Book generated using mdBook -->
<meta charset="UTF-8"><title>${title} - The Saved Site</title>
<script>window.pwned = true</script>
</head><body>
<nav id="sidebar" class="sidebar"><div class="sidebar-chrome">SIDEBAR CHROME</div></nav>
<div id="page-wrapper"><div class="page">
  <div id="menu-bar"><h1 class="menu-title">The Saved Site</h1></div>
  <div id="content" class="content"><main><h1 id="${title.toLowerCase().replace(/\W+/g, '-')}">${title}</h1>${body}</main>
  <nav class="nav-wrapper">${next ? `<a rel="next" href="${next}">Next</a>` : ''}</nav></div>
</div></div></body></html>`

export async function makeLibrary(root: string): Promise<void> {
  const write = async (path: string, content: string | Buffer) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await write('The Test Lighthouse.epub', makeEpub())
  await write('paper.pdf', makePdf(['Hello PDF world, page one.', 'This is the second page.']))
  await write('saved-site/book.js', '')
  await write(
    'saved-site/toc.html',
    `<!DOCTYPE html><html><body><ol class="chapter">
<li class="chapter-item"><a href="first.html">First Page</a></li>
<li class="chapter-item"><a href="second.html">Second Page</a></li></ol></body></html>`,
  )
  const first = mdbookPage('First Page', paragraphs('the first page', 12), 'second.html')
  await write('saved-site/index.html', first)
  await write('saved-site/first.html', first)
  await write(
    'saved-site/second.html',
    mdbookPage('Second Page', paragraphs('the second page', 12) + '<p>Unique marker: quokka.</p>', null),
  )
}
