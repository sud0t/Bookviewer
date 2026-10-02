#!/usr/bin/env node
/**
 * Drives the built app through a scenario, for checking a change by hand
 * against real books (the automated version of this is tests/e2e).
 *
 *   npm run build
 *   node scripts/drive.mjs scripts/scenarios/open-book.mjs
 *
 * The app runs on Chromium's headless display backend, so no window appears
 * (HEADED=1 shows it), with its own profile in .scratch/profile so the real
 * library database is never touched (PROFILE=<dir> picks another).
 * Screenshots land in .scratch/shots/. ALLERR=1 prints Electron's stderr.
 *
 * A scenario is a module whose default export receives
 *   { app, page, shot, drag, scratch }
 * - app / page: Playwright's ElectronApplication and the window's Page
 * - shot(name): saves .scratch/shots/<name>.png
 * - drag(x1, y1, x2, y2): selects text between two points
 * - scratch: the .scratch directory
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from '@playwright/test'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = resolve(project, '.scratch')
const profile = process.env.PROFILE ?? resolve(scratch, 'profile')
mkdirSync(resolve(scratch, 'shots'), { recursive: true })

if (!process.argv[2]) {
  console.error('usage: node scripts/drive.mjs <scenario.mjs>')
  process.exit(2)
}

const app = await electron.launch({
  args: [
    ...(process.env.HEADED ? [] : ['--ozone-platform=headless', '--ozone-override-screen-size=1600,1000']),
    '.',
  ],
  cwd: project,
  env: { ...process.env, BOOKVIEWER_USER_DATA: profile, BOOKVIEWER_DEVTOOLS: '1' },
})
const logs = []
const stderr = []
app.process().stderr?.on('data', data => stderr.push(String(data)))
app.on('console', message => logs.push('[main] ' + message.text()))
const page = await app.firstWindow()
// A headless window otherwise collapses to its minimum size.
await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1400, height: 900 }),
)
page.on('console', message => logs.push(`[${message.type()}] ${message.text()}`))
page.on('pageerror', error => logs.push('[pageerror] ' + error.stack))

const shot = name => page.screenshot({ path: resolve(scratch, 'shots', name + '.png') })
// Not a real drag: Playwright's mouse.down + mouse.move goes through CDP drag
// interception, which hangs or closes the window under Electron.
const drag = async (x1, y1, x2, y2) => {
  await page.mouse.click(x1, y1)
  await page.keyboard.down('Shift')
  await page.mouse.click(x2, y2)
  await page.keyboard.up('Shift')
}

let failed = false
try {
  const scenario = await import(pathToFileURL(resolve(process.argv[2])).href)
  await scenario.default({ app, page, shot, drag, scratch })
} catch (error) {
  failed = true
  console.error('SCENARIO FAILED', error)
  await shot('failure').catch(() => {})
} finally {
  if (logs.length) console.log('--- console ---\n' + logs.join('\n'))
  if (process.env.ALLERR) console.log('--- stderr ---\n' + stderr.join('').split('\n').slice(-40).join('\n'))
  await app.close().catch(() => {})
}
process.exit(failed ? 1 : 0)
