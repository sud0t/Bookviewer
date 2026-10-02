import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenError, makeBook, openFailure } from '../../src/renderer/engines/formats'
import { FetchError } from '../../src/renderer/engines/remote-file'

const PATH = '/home/reader/Books/Novel.epub'

describe('what the reader is told when a book cannot be opened', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => warn.mockClear())

  /** Runs the opener on some bytes and reports the failure as the reader would see it. */
  const failure = async (name: string, content: BlobPart[]): Promise<OpenError> => {
    try {
      await makeBook(new File(content, name))
    } catch (error) {
      return openFailure(error, `/books/${name}`)
    }
    throw new Error(`${name} opened`)
  }

  it('says a file that is not what its name promises is damaged', async () => {
    const error = await failure('Broken Novel.epub', ['this is not a zip file at all'])
    expect(error.kind).toBe('damaged')
    expect(error.message).toBe('This file is damaged or incomplete. Download or copy it again, then reopen it.')
    expect((await failure('Broken.mobi', ['garbage'])).kind).toBe('damaged')
  })

  it('says an archive cut short is damaged', async () => {
    // a ZIP signature with nothing behind it
    const error = await failure('Half.epub', [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])])
    expect(error.kind).toBe('damaged')
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('says an empty file is damaged', async () => {
    expect((await failure('Empty.epub', [])).kind).toBe('damaged')
  })

  it('says so when the file is a kind it cannot read', async () => {
    const error = await failure('notes.txt', ['just some text'])
    expect(error.kind).toBe('unsupported')
    expect(error.message).toMatch(/^BookViewer cannot read this kind of file\./)
  })

  it('says where a file that is gone used to be', () => {
    const error = openFailure(new FetchError('Opening Novel.epub failed: 404', 404), PATH)
    expect(error.kind).toBe('missing')
    expect(error.message).toBe(
      `Nothing was found at ${PATH}. The book may have been moved, renamed or deleted, or its drive is not connected.`,
    )
    // pdf.js reports a missing file with a status too
    const response = Object.assign(new Error('Unexpected server response (404)'), { name: 'ResponseException', status: 404 })
    expect(openFailure(response, PATH).kind).toBe('missing')
  })

  it('says a file that is there but cannot be read is unreadable, not damaged', () => {
    // no read permission: the request for the bytes just fails
    expect(openFailure(new TypeError('Failed to fetch'), PATH).kind).toBe('unreadable')
    const response = Object.assign(new Error('Unexpected server response (0)'), { name: 'ResponseException', status: 0 })
    expect(openFailure(response, PATH).message).toBe(
      'This file could not be read. Check that you are allowed to open it, then try again.',
    )
    expect(openFailure(new FetchError('Reading Novel.epub failed: 500', 500), PATH).kind).toBe('unreadable')
    // a parser tripping over the content is something else
    expect(openFailure(new TypeError("Cannot read properties of undefined (reading 'x')"), PATH).kind).toBe('damaged')
  })

  it('explains pdf.js failures', () => {
    const invalid = Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' })
    expect(openFailure(invalid, PATH).kind).toBe('damaged')
    const password = Object.assign(new Error('No password given'), { name: 'PasswordException' })
    expect(openFailure(password, PATH).message).toMatch(/locked with a password/)
  })

  it('keeps the technical cause for the console, not for the reader', () => {
    const cause = new Error('End of central directory not found')
    const error = openFailure(cause, PATH)
    expect(error.cause).toBe(cause)
    expect(error.message).not.toContain('central directory')
    expect(warn).toHaveBeenCalledWith(`Opening ${PATH} failed:`, cause)
    // already explained: passed through, and not logged twice
    warn.mockClear()
    expect(openFailure(error, PATH)).toBe(error)
    expect(warn).not.toHaveBeenCalled()
  })
})
