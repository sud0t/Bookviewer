// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { withoutIpcPrefix } from '../../src/renderer/lib/ipc'
import {
  NotCatalogError,
  folderLabel,
  friendlyError,
  homeOf,
  hostOf,
  parseFeed,
  preferredFirst,
  sameTitle,
  shortenHome,
} from '../../src/renderer/Library/opds'

/** A failure as it reaches the UI from the main process. */
const remote = (channel: string, message: string) =>
  new Error(`Error invoking remote method '${channel}': Error: ${message}`)

describe('errors from the main process', () => {
  it('lose the wrapper Electron puts around them', () => {
    expect(withoutIpcPrefix("Error invoking remote method 'opds:fetch': Error: net::ERR_NAME_NOT_RESOLVED")).toBe(
      'net::ERR_NAME_NOT_RESOLVED',
    )
    expect(withoutIpcPrefix("Error invoking remote method 'opds:download': Error: HTTP 500")).toBe('HTTP 500')
    expect(withoutIpcPrefix("Error invoking remote method 'books:get': TypeError: x is not a function")).toBe(
      'x is not a function',
    )
    expect(withoutIpcPrefix("Error invoking remote method 'tts:speak': piper exited with code 1")).toBe(
      'piper exited with code 1',
    )
  })
  it('are left alone when there is no wrapper', () => {
    expect(withoutIpcPrefix('HTTP 404')).toBe('HTTP 404')
    expect(withoutIpcPrefix('')).toBe('')
  })
})

describe('catalog errors in plain words', () => {
  const host = 'm.gutenberg.org'
  const unreachable = "Can't reach m.gutenberg.org. Check the address and your connection."
  const notResponding = "m.gutenberg.org isn't responding right now. Try again in a moment."
  const signIn = "This catalog needs a sign-in, which BookViewer doesn't support yet."
  const notFound = 'Nothing was found at that address.'
  const notCatalog = "That address isn't a catalog. Check that it is the catalog's own address, not an ordinary web page."

  it('says when the host cannot be reached', () => {
    for (const code of ['ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_CONNECTION_RESET'])
      expect(friendlyError(new Error(`net::${code}`), host)).toBe(unreachable)
  })
  it('says when there is no connection at all', () => {
    expect(friendlyError(new Error('net::ERR_INTERNET_DISCONNECTED'), host)).toBe(
      "You're offline. Check your connection and try again.",
    )
  })
  it('says when a sign-in is needed', () => {
    for (const status of [401, 403]) expect(friendlyError(new Error(`HTTP ${status}`), host)).toBe(signIn)
  })
  it('says when nothing is there', () => {
    expect(friendlyError(new Error('HTTP 404'), host)).toBe(notFound)
    expect(friendlyError(new Error('HTTP 410'), host)).toBe(notFound)
  })
  it('says when the server is not responding', () => {
    for (const message of ['HTTP 500', 'HTTP 502', 'HTTP 503', 'HTTP 504', 'HTTP 429', 'timeout', 'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_TIMED_OUT', 'This operation was aborted'])
      expect(friendlyError(new Error(message), host)).toBe(notResponding)
  })
  it('says when the address is not a catalog', () => {
    expect(friendlyError(new NotCatalogError(), host)).toBe(notCatalog)
    expect(friendlyError(new SyntaxError('Unexpected token < in JSON'), host)).toBe(notCatalog)
  })
  it('reads the status the way the main process used to send it, and bare', () => {
    expect(friendlyError(new Error('504'), host)).toBe(notResponding)
    expect(friendlyError(new Error('500 Internal Server Error'), host)).toBe(notResponding)
    expect(friendlyError(new Error('404 Not Found'), host)).toBe(notFound)
  })
  it('sees through the wrapper Electron adds, should one get this far', () => {
    expect(friendlyError(remote('opds:fetch', 'net::ERR_NAME_NOT_RESOLVED'), host)).toBe(unreachable)
    expect(friendlyError(remote('opds:download', 'HTTP 500'), host)).toBe(notResponding)
  })
  it('explains what went wrong with a download', () => {
    expect(friendlyError(new Error('not a book'), host)).toMatch(/doesn't lead to a book file/)
    expect(friendlyError(new Error('too large'), host)).toMatch(/larger than BookViewer can load/)
    expect(friendlyError(new Error("EACCES: permission denied, open '/mnt/books/x.epub.part'"), host)).toMatch(
      /isn't allowed to write to that folder/,
    )
    expect(friendlyError(new Error('ENOSPC: no space left on device, write'), host)).toMatch(/disk is full/)
    expect(friendlyError(new Error('Unknown library folder'), host)).toMatch(/folder to save into can't be found/)
  })
  it('never shows the internals, whatever the failure', () => {
    const messages = [
      remote('opds:fetch', 'net::ERR_NAME_NOT_RESOLVED'),
      new Error('HTTP 418'),
      new Error('net::ERR_CERT_DATE_INVALID'),
      new Error('Invalid URL'),
      new Error('something nobody planned for'),
      'a string',
      undefined,
    ].map(cause => friendlyError(cause, host))
    for (const message of messages) {
      expect(message).not.toMatch(/remote method|net::|ERR_|HTTP|undefined|OPDS/)
      expect(message).toMatch(/[.]$/)
    }
    expect(friendlyError(new Error('HTTP 418'), host)).toBe('m.gutenberg.org turned the request down (error 418).')
  })
  it('still makes a sentence when the host is not known', () => {
    expect(friendlyError(new Error('HTTP 503'), '')).toBe("The server isn't responding right now. Try again in a moment.")
    expect(friendlyError(new Error('net::ERR_NAME_NOT_RESOLVED'), '')).toBe(
      "Can't reach the server. Check the address and your connection.",
    )
  })
})

describe('catalog addresses and titles', () => {
  it('finds who an address talks to', () => {
    expect(hostOf('https://m.gutenberg.org/ebooks.opds/')).toBe('m.gutenberg.org')
    expect(hostOf('http://192.168.1.5:8080/opds')).toBe('192.168.1.5:8080')
    expect(hostOf('example.org/catalog')).toBe('example.org')
    expect(hostOf('')).toBe('')
  })
  it('treats titles that differ only in case and spacing as the same', () => {
    expect(sameTitle('Popular', ' popular ')).toBe(true)
    expect(sameTitle('All  Books', 'all books')).toBe(true)
    expect(sameTitle('Popular', 'Latest')).toBe(false)
  })
})

describe('formats on offer', () => {
  const formats = (...labels: string[]) => labels.map(label => ({ label, href: `/${label}` }))
  const order = (...labels: string[]) => preferredFirst(formats(...labels)).map(a => a.label)

  it('puts EPUB first, then PDF, and keeps the rest as listed', () => {
    expect(order('MOBI', 'PDF', 'EPUB', 'AZW3')).toEqual(['EPUB', 'PDF', 'MOBI', 'AZW3'])
    expect(order('MOBI', 'PDF')).toEqual(['PDF', 'MOBI'])
    expect(order('FB2', 'CBZ')).toEqual(['FB2', 'CBZ'])
    expect(order()).toEqual([])
  })

  const atom = (body: string) => ({
    url: 'https://example.org/opds/books',
    contentType: 'application/atom+xml;profile=opds-catalog',
    body: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Books</title>${body}</feed>`,
  })

  it('orders the downloads of a book read from a feed', () => {
    const feed = parseFeed(
      atom(`<entry><title>A Book</title><author><name>Ann Author</name></author>
        <link rel="http://opds-spec.org/acquisition" href="a.mobi" type="application/x-mobipocket-ebook"/>
        <link rel="http://opds-spec.org/acquisition" href="a.pdf" type="application/pdf"/>
        <link rel="http://opds-spec.org/acquisition" href="a.epub" type="application/epub+zip"/>
        <link rel="http://opds-spec.org/acquisition/buy" href="buy.html" type="text/html"/>
      </entry>`),
    )
    const [book] = feed.groups[0].publications
    expect(book.title).toBe('A Book')
    expect(book.acquisitions).toEqual([
      { label: 'EPUB', href: 'https://example.org/opds/a.epub' },
      { label: 'PDF', href: 'https://example.org/opds/a.pdf' },
      { label: 'MOBI', href: 'https://example.org/opds/a.mobi' },
    ])
  })

  it('refuses what is not a catalog', () => {
    const page = (body: string, contentType = 'text/html') => ({ url: 'https://example.org/', contentType, body })
    expect(() => parseFeed(page('<!doctype html><html><head><title>Hi</title></head><body><p>Hello<br>there</body></html>'))).toThrow(NotCatalogError)
    expect(() => parseFeed(page('<?xml version="1.0"?><rss version="2.0"><channel/></rss>', 'application/xml'))).toThrow(NotCatalogError)
    expect(() => parseFeed(page('{"error": "no such thing"}', 'application/json'))).toThrow(NotCatalogError)
    expect(() => parseFeed(page('{not json', 'application/json'))).toThrow(NotCatalogError)
    expect(() => parseFeed(page('[1, 2]', 'application/json'))).toThrow(NotCatalogError)
    expect(parseFeed(page('{"metadata": {"title": "Shelf"}, "navigation": []}', 'application/opds+json')).title).toBe('Shelf')
  })
})

describe('where downloads are saved', () => {
  it('works out the home directory from the library folders', () => {
    expect(homeOf(['/home/ann/Books', '/home/ann/Documents/papers'])).toBe('/home/ann')
    expect(homeOf(['/home/ann/Books', '/mnt/usb/Books'])).toBe('/home/ann')
    expect(homeOf(['/root/books'])).toBe('/root')
    expect(homeOf(['/home/ann/Books', '/home/bob/Books'])).toBeNull()
    expect(homeOf(['/mnt/usb/Books'])).toBeNull()
    expect(homeOf([])).toBeNull()
  })
  it('shortens paths inside the home directory only', () => {
    expect(shortenHome('/home/ann/Books', '/home/ann')).toBe('~/Books')
    expect(shortenHome('/home/ann', '/home/ann')).toBe('~')
    expect(shortenHome('/home/annette/Books', '/home/ann')).toBe('/home/annette/Books')
    expect(shortenHome('/mnt/usb/Books', '/home/ann')).toBe('/mnt/usb/Books')
    expect(shortenHome('/home/ann/Books', null)).toBe('/home/ann/Books')
  })
  it('keeps the end of a path too long to show', () => {
    expect(shortenHome('/home/ann/Documents/Reading/2026/Fiction/Shelves/Books', '/home/ann')).toBe('…/Shelves/Books')
    expect(shortenHome('/run/media/ann/A Drive With A Long Name/Library/Books', '/home/ann')).toBe('…/Library/Books')
  })
  it('labels a folder by name and place, so two of the same name can be told apart', () => {
    expect(folderLabel('/home/ann/Books', '/home/ann')).toBe('Books (~/Books)')
    expect(folderLabel('/mnt/usb/Books', '/home/ann')).toBe('Books (/mnt/usb/Books)')
  })
})
