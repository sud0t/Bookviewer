/**
 * Walks through every screen and takes a screenshot of each, in a light and a
 * dark theme, so that a UI change can be looked at as a whole.
 *
 *   npm run build
 *   PROFILE=.scratch/tour node scripts/drive.mjs scripts/scenarios/ui-tour.mjs [folder]
 *
 * Shots land in .scratch/shots/tour-<theme>-<screen>.png. THEMES=light,sepia
 * picks other themes. With AXE=1 every screen is also checked with axe-core
 * and the violations are printed (contrast, missing names, roles).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const folder = process.argv[3] ?? `${process.env.HOME}/Books`
const themes = (process.env.THEMES ?? 'light,dark').split(',')
const axeSource = process.env.AXE
  ? readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
  : null

export default async ({ page, shot }) => {
  const invoke = (channel, ...args) =>
    page.evaluate(([c, a]) => window.bridge.invoke(c, ...a), [channel, args])

  const check = async name => {
    if (!axeSource) return
    await page.evaluate(axeSource)
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, { resultTypes: ['violations'] })
      return result.violations.map(v => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 4).map(n => n.target.join(' ') + (n.failureSummary ? '' : '')),
        count: v.nodes.length,
      }))
    })
    for (const v of violations)
      console.log(`axe ${name}: [${v.impact}] ${v.id} x${v.count} - ${v.help}\n    ${v.nodes.join('\n    ')}`)
  }

  const capture = async name => {
    await page.waitForTimeout(350)
    await shot(name)
    await check(name)
  }

  await page.waitForSelector('.library')
  await invoke('folders:addPath', folder)
  await page.waitForSelector('.card', { timeout: 30000 })
  await page.waitForTimeout(4000) // titles and covers

  for (const theme of themes) {
    const name = screen => `tour-${theme}-${screen}`
    await invoke('settings:set', { themeAuto: false, theme, libraryView: 'grid', flow: 'scrolled' })
    await page.reload()
    await page.waitForSelector('.card')
    await page.waitForTimeout(1200)
    await capture(name('library-grid'))

    await page.getByRole('button', { name: /grid or list|Show as list|List view/i }).first().click()
    await capture(name('library-list'))
    await page.getByRole('button', { name: /grid or list|Show as grid|Grid view/i }).first().click()

    // Open the first reflowable book (not a PDF), so every reader control applies.
    const books = await invoke('books:list')
    const book = books.find(b => b.format === 'epub') ?? books[0]
    await page.locator(`.card[title=${JSON.stringify(book.title)}]`).first().click()
    await page.waitForSelector('.reader')
    await page.waitForTimeout(3500)
    await page.mouse.move(800, 450)
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 700)
    await page.waitForTimeout(1200)
    await capture(name('reader'))

    await page.keyboard.press('Control+d')
    await page.waitForTimeout(500)
    await shot(name('reader-bookmarked'))

    await page.getByRole('button', { name: /side panel|Contents/i }).first().click()
    await capture(name('panel-contents'))
    for (const tab of ['Highlights', 'Bookmarks', 'Search']) {
      const button = page.getByRole('tab', { name: tab })
      if (!(await button.count())) continue
      await button.click()
      if (tab === 'Search') {
        await page.waitForTimeout(200) // the field takes focus on the next frame
        await page.keyboard.type('python')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(2500)
      }
      await capture(name('panel-' + tab.toLowerCase()))
    }

    await page.getByRole('button', { name: 'Text and theme' }).click()
    await capture(name('appearance'))
    await page.keyboard.press('Escape')

    await invoke('settings:set', { flow: 'paginated' })
    await page.reload()
    await page.waitForSelector('.card')
    await page.locator(`.card[title=${JSON.stringify(book.title)}]`).first().click()
    await page.waitForSelector('.reader')
    await page.waitForTimeout(3500)
    await capture(name('reader-paginated'))

    await page.getByRole('button', { name: /Back to library|Library/ }).first().click()
    await page.waitForSelector('.reader', { state: 'detached' })
  }
}
