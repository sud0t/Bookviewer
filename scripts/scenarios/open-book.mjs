/**
 * Example scenario: add a folder, open the first book in it, scroll, take a
 * screenshot. Copy it as a starting point.
 *
 *   node scripts/drive.mjs scripts/scenarios/open-book.mjs [folder]
 *
 * Things worth knowing when writing one:
 * - Native dialogs block forever when headless: add folders through the
 *   `folders:addPath` channel, not the "Add folder" button, and stay away
 *   from the export buttons (or stub `dialog.showSaveDialog` via app.evaluate).
 * - Book content lives in sandboxed iframes inside the <bv-scroller> shadow
 *   root; reach it with page.evaluate through iframe.contentDocument (as
 *   `loadedText` does below), not with frame locators.
 */
const folder = process.argv[3] ?? `${process.env.HOME}/Books`

const footer = page =>
  page.evaluate(() => document.querySelector('.status')?.textContent.replace(/\s+/g, ' ').trim())

const loadedText = page =>
  page.evaluate(() => {
    const scroller = document.querySelector('.reader bv-scroller')
    const frames = scroller?.shadowRoot?.querySelectorAll('iframe') ?? []
    return [...frames].map(frame => frame.contentDocument?.body?.textContent ?? '').join('\n')
  })

export default async ({ page, shot }) => {
  await page.waitForSelector('.library')
  await page.evaluate(path => window.bridge.invoke('folders:addPath', path), folder)
  await page.waitForSelector('.card', { timeout: 30000 })
  await page.waitForTimeout(3000) // let titles and covers come in
  const books = await page.evaluate(() => window.bridge.invoke('books:list'))
  for (const book of books) console.log(book.format, book.metaState, JSON.stringify(book.title))
  await shot('library')

  await page.locator('.card').first().click()
  await page.waitForSelector('.reader')
  await page.waitForTimeout(3000)
  console.log('opened at:', await footer(page))
  await page.mouse.move(700, 450)
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 800)
  await page.waitForTimeout(1500)
  console.log('after scrolling:', await footer(page))
  console.log('text loaded:', (await loadedText(page)).length, 'characters')
  await shot('reader')
}
