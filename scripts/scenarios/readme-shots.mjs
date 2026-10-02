/**
 * Retakes the README's screenshots (docs/screenshots/*.png) after a UI change.
 *
 *   npm run build
 *   PROFILE=.scratch/readme node scripts/drive.mjs scripts/scenarios/readme-shots.mjs [books] [saved-site]
 *
 * `books` is a folder with EPUBs and PDFs (default ~/Books); `saved-site` a
 * saved HTML book (default: the kitty manual, a Sphinx site). Start from a
 * fresh profile, or old progress and bookmarks end up in the pictures.
 */
import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const books = process.argv[3] ?? `${process.env.HOME}/Books`
const site = process.argv[4] ?? '/usr/share/doc/kitty/html'

export default async ({ page, shot, drag, scratch }) => {
  const invoke = (channel, ...args) =>
    page.evaluate(([c, a]) => window.bridge.invoke(c, ...a), [channel, args])
  const keep = async name => {
    await page.waitForTimeout(500)
    await shot(name)
    copyFileSync(resolve(scratch, 'shots', name + '.png'), resolve(scratch, '..', 'docs/screenshots', name + '.png'))
  }
  const open = async book => {
    await page.locator(`.card[title=${JSON.stringify(book.title)}] .open`).first().click()
    await page.waitForSelector('.reader')
    await page.waitForTimeout(3500)
    await page.mouse.move(700, 450)
  }
  const leave = async () => {
    await page.getByRole('button', { name: 'Back to library' }).click()
    await page.waitForSelector('.reader', { state: 'detached' })
  }

  await page.waitForSelector('.library')
  await invoke('folders:addPath', books)
  if (existsSync(site)) await invoke('folders:addPath', site)
  await page.waitForSelector('.card', { timeout: 30000 })
  await page.waitForTimeout(5000)
  await invoke('settings:set', { themeAuto: false, theme: 'light', libraryView: 'grid', flow: 'scrolled' })
  await page.reload()
  await page.waitForSelector('.card')
  const list = await invoke('books:list')
  const epub = list.find(b => b.format === 'epub')
  const pdf = list.find(b => b.format === 'pdf')
  const web = list.find(b => b.format === 'web')

  // An EPUB a little way in, with a highlight and a bookmark: this also puts
  // a book on the library's "Continue reading" shelf.
  await open(epub)
  await page.keyboard.press('Control+g')
  await page.locator('.goto input').fill('60')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
  await drag(360, 300, 760, 330)
  await page.waitForTimeout(400)
  if (await page.locator('.selection-menu .dot').count()) await page.locator('.selection-menu .dot').first().click()
  await page.keyboard.press('Control+d')
  await page.getByRole('button', { name: 'Toggle side panel' }).click()
  await keep('reader')
  await leave()

  await keep('library')

  if (web) {
    await open(web)
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 500)
    await page.getByRole('button', { name: 'Toggle side panel' }).click()
    await keep('web-book')
    await leave()
  }

  if (pdf) {
    await open(pdf)
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 900)
    await keep('pdf')
    await leave()
  }

  await invoke('settings:set', { theme: 'dark', flow: 'paginated' })
  await page.reload()
  await page.waitForSelector('.card')
  await open(epub)
  await keep('paginated-dark')
}
