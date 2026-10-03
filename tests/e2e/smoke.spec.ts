import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
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
  // nothing a test clicks may open the real browser or file manager
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {}
    shell.showItemInFolder = () => {}
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
    await expect(page.getByRole('heading', { name: 'Add a folder to start your library' })).toBeVisible()
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
    // later chapters are stitched on below the first, a couple of screens ahead
    await page.mouse.move(640, 400)
    await page.mouse.wheel(0, 500)
    await expect.poll(loadedText).toContain('Paragraph 1 about the storm')
    // nothing a book carries may run: its pages share the app's origin
    expect(await page.evaluate(() => (window as Window & { pwned?: string }).pwned)).toBeUndefined()
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

  test('marks a bookmarked page, and takes the bookmark back', async () => {
    const button = page.getByRole('button', { name: 'Bookmark this page' })
    const ribbon = page.locator('.ribbon')
    await expect(ribbon).toHaveCount(0)
    await page.keyboard.press('Control+d')
    await expect(ribbon).toBeVisible()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.toast')).toContainText('Bookmarked location')
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
    await expect(ribbon).toHaveCount(0)

    // the toolbar button does the same, and the bookmark is listed
    await button.click()
    await expect(ribbon).toBeVisible()
    await page.locator('.panel [role="tab"][title="Bookmarks"]').click()
    await expect(page.locator('.panel .bookmark')).toHaveCount(1)

    // the mark belongs to its page: gone elsewhere, back when we return
    await page.locator('.panel [role="tab"][title="Contents"]').click()
    await page.locator('.panel .label', { hasText: 'Morning' }).click()
    await expect(page.locator('.toolbar .title')).toContainText('Morning')
    await expect(ribbon).toHaveCount(0)
    await page.locator('.panel [role="tab"][title="Bookmarks"]').click()
    await page.locator('.panel .bookmark-body').click()
    await expect(page.locator('.toolbar .title')).toContainText('Arrival')
    await expect(ribbon).toBeVisible()

    // clicking the ribbon takes the bookmark away
    await ribbon.click()
    await expect(ribbon).toHaveCount(0)
    await expect(page.locator('.panel .bookmark')).toHaveCount(0)
  })

  test('searches the whole book', async () => {
    await page.locator('.panel [role="tab"][title="Search"]').click()
    await page.locator('.panel .search input[type="text"]').fill('zebrafish')
    await page.keyboard.press('Enter')
    await expect(page.locator('.panel .hit')).toHaveCount(1)
    await page.locator('.panel .hit').click()
    await expect(page.locator('.toolbar .title')).toContainText('Morning')
    // the result the reader is on is filled in, not just outlined
    await expect
      .poll(() =>
        page.evaluate(() => {
          const deep = (root: Document | ShadowRoot): number =>
            root.querySelectorAll('g[fill-opacity]').length +
            [...root.querySelectorAll('*')].reduce(
              (n, el) =>
                n +
                (el.shadowRoot ? deep(el.shadowRoot) : 0) +
                (el instanceof HTMLIFrameElement && el.contentDocument ? deep(el.contentDocument) : 0),
              0,
            )
          return deep(document)
        }),
      )
      .toBe(1)
  })

  test('right-click picks the word under the pointer', async () => {
    await expect.poll(() => locate('zebrafish')).not.toBeNull()
    const at = (await locate('zebrafish'))!
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await expect(page.locator('.selection-menu')).toBeVisible()
    await page.locator('.selection-menu').getByRole('button', { name: 'Define' }).click()
    await expect(page.locator('.lookup')).toContainText('zebrafish')
    await page.keyboard.press('Escape')
  })

  test('F6 moves between the book and the toolbar', async () => {
    const inToolbar = () => page.evaluate(() => !!document.activeElement?.closest('.toolbar'))
    await page.keyboard.press('F6')
    expect(await inToolbar()).toBe(true)
    await page.keyboard.press('F6')
    expect(await inToolbar()).toBe(false)
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
    await expect(page.locator('.status')).toContainText('Page 1 of 3')
  })

  test('goes to a page by its number', async () => {
    await page.keyboard.press('Control+g')
    await page.locator('.goto input').fill('2')
    await page.keyboard.press('Enter')
    await expect(page.locator('.status')).toContainText('Page 2 of 3')
    // "back" returns to where the jump was made from
    await page.getByRole('button', { name: 'Go back' }).click()
    await expect(page.locator('.status')).toContainText('Page 1 of 3')
    await backToLibrary()
  })

  test('marks a book as finished from its menu', async () => {
    const card = page.locator('.card[title="A Test Paper"]')
    await card.hover()
    await card.getByRole('button', { name: /More actions/ }).click()
    await page.getByRole('menuitem', { name: 'Mark as finished' }).click()
    await expect(card).toContainText('Finished')
    // and back again, which also forgets the place
    await card.getByRole('button', { name: /More actions/ }).click()
    await page.getByRole('menuitem', { name: 'Mark as unread' }).click()
    await expect(card).not.toContainText('Finished')
    await expect(card.locator('.progress')).toHaveCount(0)
    // a slip in the menu can be taken back
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
    await expect(card).toContainText('Finished')
  })

  test('opens a book from its details', async () => {
    const card = page.locator('.card[title="The Test Lighthouse"]')
    await card.hover()
    await card.getByRole('button', { name: /More actions/ }).click()
    await page.getByRole('menuitem', { name: 'Book details' }).click()
    const dialog = page.getByRole('dialog', { name: 'Book details' })
    await expect(dialog).toContainText('Ada Example')
    await dialog.getByRole('button', { name: /Continue reading|Open/ }).click()
    await expect(page.locator('.reader')).toBeVisible()
    await expect(dialog).toHaveCount(0)
    await backToLibrary()
  })
})

test.describe.serial('coming back to a book', () => {
  const pdfPosition = (): Promise<{ page: number; inPage: number }> =>
    page.evaluate(() => {
      const container = document.querySelector<HTMLElement>('.reader .bv-pdf')!
      const pages = [...container.querySelectorAll<HTMLElement>('.page')]
      const current = pages.findLast(p => p.offsetTop <= container.scrollTop + 1) ?? pages[0]
      return {
        page: Number(current.dataset.pageNumber),
        inPage: (container.scrollTop - current.offsetTop) / current.offsetHeight,
      }
    })

  const progressOf = (title: string): Promise<number> =>
    page.evaluate(
      title => window.bridge.invoke('books:list').then(books => books.find(b => b.title === title)!.progress),
      title,
    )

  test('reopens an EPUB at the same text, however often', async () => {
    await openBook('The Test Lighthouse')
    await expect.poll(loadedText).toContain('Paragraph 1 about')
    await page.keyboard.press('Home')
    await expect(page.locator('.toolbar .title')).toContainText('Arrival')
    // to the middle of a long paragraph, where there is nothing but lines of text to hold on to
    await expect.poll(() => locate('Sentence 30 of')).not.toBeNull()
    await page.mouse.move(640, 430)
    await page.mouse.wheel(0, (await locate('Sentence 30 of'))!.y - 150)
    await page.waitForTimeout(500)
    const left = (await locate('Sentence 30 of'))!.y
    expect(left).toBeGreaterThan(60)
    expect(left).toBeLessThan(260)

    const seen: number[] = []
    for (let round = 0; round < 3; round++) {
      await backToLibrary()
      await openBook('The Test Lighthouse')
      await expect.poll(() => locate('Sentence 30 of')).not.toBeNull()
      await page.waitForTimeout(600)
      seen.push((await locate('Sentence 30 of'))!.y)
    }
    // within a line of where it was, and not a line further off every time
    expect(Math.abs(seen[0] - left)).toBeLessThan(40)
    expect(Math.abs(seen[2] - seen[0])).toBeLessThan(2)
    await backToLibrary()
  })

  test('saves where the reader is even when leaving in mid-scroll', async () => {
    await openBook('The Test Lighthouse')
    await expect.poll(loadedText).toContain('Paragraph 1 about')
    await page.keyboard.press('Home')
    await expect(page.locator('.toolbar .title')).toContainText('Arrival')
    await page.waitForTimeout(1000)
    const before = await progressOf('The Test Lighthouse')
    await page.mouse.move(640, 430)
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 400)
    // no pause: the scroll has not been reported yet
    await backToLibrary()
    expect(await progressOf('The Test Lighthouse')).toBeGreaterThan(before + 0.01)
  })

  test('reopens a PDF at the same place in a page that is not the size of the first', async () => {
    await openBook('A Test Paper')
    await expect(page.locator('.bv-pdf .page')).toHaveCount(3)
    await page.mouse.move(640, 430)
    // into the second page, which is shorter than the cover
    const cover = await page.locator('.bv-pdf .page').first().evaluate(el => (el as HTMLElement).offsetHeight)
    await page.locator('.bv-pdf').evaluate((el, top) => (el.scrollTop = top), cover + 400)
    await page.waitForTimeout(400)
    const left = await pdfPosition()
    expect(left.page).toBe(2)

    for (let round = 0; round < 2; round++) {
      await backToLibrary()
      await openBook('A Test Paper')
      await expect(page.locator('.status')).toContainText('Page 2 of 3')
      await page.waitForTimeout(600)
      const now = await pdfPosition()
      expect(now.page).toBe(2)
      expect(Math.abs(now.inPage - left.inPage)).toBeLessThan(0.01)
    }
    await backToLibrary()
  })

  test('counts a short book read to its end as finished', async () => {
    await openBook('A Test Paper')
    // (once it is back where it was left)
    await expect(page.locator('.status')).toContainText('Page 2 of 3')
    await page.locator('.bv-pdf').evaluate(el => (el.scrollTop = el.scrollHeight))
    await expect(page.locator('.status')).toContainText('100%')
    await backToLibrary()
    expect(await progressOf('A Test Paper')).toBe(1)
    // ... while one left part-way is still being read
    const progress = await progressOf('The Test Lighthouse')
    expect(progress).toBeGreaterThan(0)
    expect(progress).toBeLessThan(0.99)
  })

  test('keeps a page turned just before leaving', async () => {
    await page.evaluate(() => window.bridge.invoke('settings:set', { flow: 'paginated' }))
    await page.reload()
    await openBook('The Test Lighthouse')
    await expect(page.getByRole('button', { name: 'Next page' })).toBeVisible()
    await page.waitForTimeout(1000)
    // (the paginated renderer's frames allow scripts; the content policy must still stop a book's)
    expect(await page.evaluate(() => (window as Window & { pwned?: string }).pwned)).toBeUndefined()
    const before = await progressOf('The Test Lighthouse')
    await page.keyboard.press('ArrowRight')
    // no pause: the turn is still being animated, and is only reported at its end
    await backToLibrary()
    expect(await progressOf('The Test Lighthouse')).toBeGreaterThan(before + 0.01)

    await page.evaluate(() => window.bridge.invoke('settings:set', { flow: 'scrolled' }))
    await page.reload()
    await expect(page.locator('.card')).toHaveCount(3)
  })
})

test.describe.serial('the library', () => {
  test('moves between books with the arrow keys', async () => {
    const focused = () => page.evaluate(() => document.activeElement?.closest('.card')?.getAttribute('title'))
    const titles = await page.locator('.grid .card').evaluateAll(cards => cards.map(c => c.getAttribute('title')))
    await page.locator('.grid .card .open').first().focus()
    await page.keyboard.press('ArrowRight')
    expect(await focused()).toBe(titles[1])
    await page.keyboard.press('End')
    expect(await focused()).toBe(titles[2])
    await page.keyboard.press('ArrowLeft')
    expect(await focused()).toBe(titles[1])
  })

  test('removes one book, and puts it back', async () => {
    const card = page.locator('.card[title="The Saved Site"]')
    await card.hover()
    await card.getByRole('button', { name: /More actions/ }).click()
    await page.getByRole('menuitem', { name: 'Remove from library' }).click()
    await expect(page.locator('.card')).toHaveCount(2)
    // a rescan does not bring it back
    await page.evaluate(() => window.bridge.invoke('folders:rescan'))
    await expect(page.locator('.card')).toHaveCount(2)
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.card')).toHaveCount(3)

    await page.evaluate(() =>
      window.bridge.invoke('books:list').then(books =>
        window.bridge.invoke('books:setHidden', books.find(b => b.title === 'The Saved Site')!.id, true),
      ),
    )
    await page.reload()
    await expect(page.locator('.card')).toHaveCount(2)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: /Put back removed book/ }).click()
    await expect(page.locator('.card')).toHaveCount(3)
  })

  test('opens a book file handed to the app from outside the library', async () => {
    const source = await page.evaluate(() =>
      window.bridge.invoke('books:list').then(books => books.find(b => b.format === 'epub')!.path),
    )
    const loose = join(scratch, 'elsewhere', 'loose.epub')
    await mkdir(join(scratch, 'elsewhere'))
    await copyFile(source, loose)
    // (what a drop on the window, or `bookviewer loose.epub`, ends up calling)
    const id = await page.evaluate(path => window.bridge.invoke('library:openPaths', [path]), loose)
    expect(id).not.toBeNull()
    await expect(page.locator('.card')).toHaveCount(4)
    const folders = await page.evaluate(() => window.bridge.invoke('folders:list'))
    expect(folders.map(f => f.path)).toContain(loose)
  })
})
