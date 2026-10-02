import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { makeLibrary } from './fixtures'

let app: ElectronApplication
let page: Page
let scratch: string

/** Text of every section currently loaded in the continuous scroller. */
const loadedText = (): Promise<string> =>
  page.evaluate(() => {
    const scroller = document.querySelector('.reader bv-scroller')
    const frames = scroller?.shadowRoot?.querySelectorAll('iframe') ?? []
    return [...frames].map(frame => frame.contentDocument?.body?.textContent ?? '').join('\n')
  })

/** Where a piece of text sits in the window, looking through the book's frames. */
const locate = (text: string): Promise<{ x: number; y: number } | null> =>
  page.evaluate(needle => {
    const scroller = document.querySelector('.reader bv-scroller')
    for (const frame of scroller?.shadowRoot?.querySelectorAll('iframe') ?? []) {
      const doc = frame.contentDocument
      if (!doc?.body) continue
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.nodeValue?.indexOf(needle) ?? -1
        if (at < 0) continue
        const range = doc.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        const rect = range.getBoundingClientRect()
        const origin = frame.getBoundingClientRect()
        return { x: origin.left + rect.left + rect.width / 2, y: origin.top + rect.top + rect.height / 2 }
      }
    }
    return null
  }, text)

const openBook = async (title: string) => {
  await page.locator(`.card[title="${title}"]`).click()
  await expect(page.locator('.reader')).toBeVisible()
}

const backToLibrary = async () => {
  await page.getByRole('button', { name: 'Back to library' }).click()
  await expect(page.locator('.reader')).toHaveCount(0)
}

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'bookviewer-e2e-'))
  await makeLibrary(join(scratch, 'library'))
  app = await electron.launch({
    // No window on screen unless asked for: Chromium's headless display backend.
    args: [...(process.env.HEADED ? [] : ['--ozone-platform=headless']), '.'],
    env: { ...process.env, BOOKVIEWER_USER_DATA: join(scratch, 'profile') },
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1280, height: 860 }),
  )
})

test.afterAll(async () => {
  await app?.close()
  await rm(scratch, { recursive: true, force: true })
})

test.describe.serial('reading', () => {
  test('indexes a folder and shows its books', async () => {
    await expect(page.getByText('Your library is empty')).toBeVisible()
    await page.evaluate(path => window.bridge.invoke('folders:addPath', path), join(scratch, 'library'))
    await expect(page.locator('.card')).toHaveCount(3)
    // titles and authors come from the files' own metadata
    await expect(page.locator('.card[title="The Test Lighthouse"]')).toContainText('Ada Example')
    await expect(page.locator('.card[title="A Test Paper"]')).toContainText('Bob Example')
    await expect(page.locator('.card[title="The Saved Site"]')).toBeVisible()
    // the PDF's first page became its cover
    await expect(page.locator('.card[title="A Test Paper"] img')).toBeVisible()
  })

  test('opens an EPUB as one continuous scroll', async () => {
    await openBook('The Test Lighthouse')
    await expect.poll(loadedText).toContain('Paragraph 1 about arrival')
    // later chapters are stitched on below the first
    await expect.poll(loadedText).toContain('Paragraph 1 about the storm')
    await expect(page.locator('.toolbar .title')).toContainText('Arrival')
  })

  test('navigates by the table of contents and renders math', async () => {
    await page.getByRole('button', { name: 'Toggle side panel' }).click()
    await page.locator('.panel .label', { hasText: 'The Storm' }).click()
    await expect(page.locator('.toolbar .title')).toContainText('The Storm')
    await expect
      .poll(() =>
        page.evaluate(() => {
          const scroller = document.querySelector('.reader bv-scroller')
          const frames = [...(scroller?.shadowRoot?.querySelectorAll('iframe') ?? [])]
          return frames.reduce((n, f) => n + (f.contentDocument?.querySelectorAll('mjx-container svg').length ?? 0), 0)
        }),
      )
      .toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Close panel' }).click()
  })

  test('highlights a selection and finds it again after reopening', async () => {
    const word = await locate('barometer')
    expect(word).not.toBeNull()
    await page.mouse.dblclick(word!.x, word!.y)
    await expect(page.locator('.selection-menu')).toBeVisible()
    await page.locator('.selection-menu .dot').first().click()
    await expect(page.locator('.selection-menu')).toHaveCount(0)

    const marks = () =>
      page.evaluate(() => {
        const scroller = document.querySelector('.reader bv-scroller')
        return scroller?.shadowRoot?.querySelectorAll('.view svg g').length ?? 0
      })
    await expect.poll(marks).toBe(1)

    await backToLibrary()
    await expect(page.locator('.card[title="The Test Lighthouse"] .progress')).toBeVisible()
    await openBook('The Test Lighthouse')
    // back where we were, with the highlight re-anchored
    await expect(page.locator('.toolbar .title')).toContainText('The Storm')
    await expect.poll(marks).toBe(1)

    await page.getByRole('button', { name: 'Toggle side panel' }).click()
    await page.locator('.panel [role="tab"][title="Highlights"]').click()
    await expect(page.locator('.panel .note')).toContainText('barometer')
  })

  test('keeps the reading position when the text is resized', async () => {
    // Shrinking the text makes everything above the viewport shorter.
    for (let i = 0; i < 6; i++) await page.keyboard.press('Control+-')
    await expect.poll(() => page.evaluate(() => window.bridge.invoke('settings:get').then(s => s.fontSize))).toBe(12)
    await page.waitForTimeout(600)
    await expect(page.locator('.toolbar .title')).toContainText('The Storm')
    expect(await locate('barometer')).not.toBeNull()
    const { y } = (await locate('barometer'))!
    expect(y).toBeGreaterThan(40)
    expect(y).toBeLessThan(700)
    for (let i = 0; i < 6; i++) await page.keyboard.press('Control+=')
    await page.waitForTimeout(600)
    await expect(page.locator('.toolbar .title')).toContainText('The Storm')
  })

  test('keeps loading chapters after jumping around quickly', async () => {
    await page.locator('.panel [role="tab"][title="Contents"]').click()
    // a jump while the previous one's neighbours are still loading
    await page.locator('.panel .label', { hasText: 'Morning' }).click()
    await page.locator('.panel .label', { hasText: 'Arrival' }).click()
    await expect(page.locator('.toolbar .title')).toContainText('Arrival')
    await expect.poll(loadedText).toContain('Paragraph 1 about arrival')
    // the following chapter still gets stitched on
    await expect.poll(loadedText).toContain('Paragraph 1 about the storm')
  })

  test('searches the whole book', async () => {
    await page.locator('.panel [role="tab"][title="Search"]').click()
    await page.locator('.panel .search input[type="text"]').fill('zebrafish')
    await page.keyboard.press('Enter')
    await expect(page.locator('.panel .hit')).toHaveCount(1)
    await page.locator('.panel .hit').click()
    await expect(page.locator('.toolbar .title')).toContainText('Morning')
    await backToLibrary()
  })

  test('reads a saved HTML site as a book, without its chrome or scripts', async () => {
    await openBook('The Saved Site')
    await expect.poll(loadedText).toContain('Paragraph 1 about the first page')
    // the next page follows in the same scroll
    await expect.poll(loadedText).toContain('quokka')
    const text = await loadedText()
    expect(text).not.toContain('SIDEBAR CHROME')
    const scriptRan = await page.evaluate(() => {
      const scroller = document.querySelector('.reader bv-scroller')
      const frame = scroller?.shadowRoot?.querySelector('iframe')
      return (frame?.contentWindow as (Window & { pwned?: boolean }) | null)?.pwned === true
    })
    expect(scriptRan).toBe(false)
    await backToLibrary()
  })

  test('opens a PDF with selectable text', async () => {
    await openBook('A Test Paper')
    await expect(page.locator('.bv-pdf .textLayer').first()).toContainText('Hello PDF world')
    await expect(page.locator('.status')).toContainText('Page 1 of 2')
    await backToLibrary()
  })
})
