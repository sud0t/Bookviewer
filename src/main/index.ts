import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Menu, app, nativeTheme, screen, session } from 'electron'
import type { IpcEvent, IpcEvents } from '@shared/types'
import icon from '../../resources/icon.png?asset'
import { Store } from './db'
import { openExternal, registerIpc } from './ipc'
import { Library } from './library'
import { handleAppProtocol, handleBookProtocol, registerSchemes } from './protocol'

const DEV_URL = process.env.ELECTRON_RENDERER_URL
const APP_URL = DEV_URL ?? 'app://bundle/index.html'

/**
 * Whether a URL is the app's own UI. (Not an `origin` comparison: custom
 * schemes all have the opaque origin "null" as far as Node's URL goes.)
 */
function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (DEV_URL) return parsed.origin === new URL(DEV_URL).origin
    return parsed.protocol === 'app:' && parsed.host === 'bundle'
  } catch {
    return false
  }
}

// Lets tests (and anyone who wants a second, separate library) point the app
// at a different profile directory.
if (process.env.BOOKVIEWER_USER_DATA) app.setPath('userData', process.env.BOOKVIEWER_USER_DATA)

registerSchemes()

let mainWindow: BrowserWindow | null = null
let store: Store | null = null
let library: Library | null = null

function send<K extends IpcEvent>(event: K, payload?: IpcEvents[K]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, payload)
}

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

function restoreWindowState(): WindowState {
  const fallback: WindowState = { width: 1280, height: 860, maximized: false }
  const state = store?.getWindowState(fallback) ?? fallback
  // Drop a saved position that no longer lands on any display.
  if (state.x != null && state.y != null) {
    const visible = screen.getAllDisplays().some(({ workArea }) => {
      return (
        state.x! >= workArea.x - 50 &&
        state.y! >= workArea.y - 50 &&
        state.x! < workArea.x + workArea.width - 100 &&
        state.y! < workArea.y + workArea.height - 100
      )
    })
    if (!visible) {
      delete state.x
      delete state.y
    }
  }
  return state
}

function createWindow(): void {
  const state = restoreWindowState()
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: 'BookViewer',
    icon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b1a' : '#f6f5f2',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  mainWindow = window
  if (state.maximized) window.maximize()
  window.once('ready-to-show', () => window.show())

  const saveState = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
    const maximized = window.isMaximized()
    const bounds = maximized ? (store?.getWindowState(state) ?? state) : window.getBounds()
    store?.setWindowState({ ...bounds, maximized })
  }
  window.on('close', saveState)
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  window.on('enter-full-screen', () => send('window:fullscreen', true))
  window.on('leave-full-screen', () => send('window:fullscreen', false))

  const { webContents } = window
  // The UI is a single page: nothing may navigate it away or open windows,
  // and book content must not pull in remote documents.
  webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternal(url)
  })
  webContents.on('will-frame-navigate', event => {
    if (event.isMainFrame) return
    if (/^(blob|about):/i.test(event.url)) return
    event.preventDefault()
    openExternal(event.url)
  })
  webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key === 'I')
    if (devtools && (DEV_URL || process.env.BOOKVIEWER_DEVTOOLS)) webContents.toggleDevTools()
  })

  void window.loadURL(APP_URL)
}

/**
 * The file or folder named on a command line, if any: `bookviewer book.epub`.
 * (The rest of argv is Electron's own: switches, and the app's directory.)
 */
function pathArgument(argv: string[], cwd: string): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    let path: string
    try {
      // (file managers hand over file:// URLs, percent-encoded)
      path = arg.startsWith('file://') ? fileURLToPath(arg) : resolve(cwd, arg)
    } catch {
      continue
    }
    if (path === resolve(app.getAppPath())) continue
    if (existsSync(path)) return path
  }
  return null
}

/** The book named when this run was started; the UI asks for it once it is up. */
let launchBook: Promise<number | null> = Promise.resolve(null)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  app.on('second-instance', (_event, argv, cwd) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    const path = pathArgument(argv, cwd)
    if (path)
      void library?.openPath(path).then(id => {
        if (id != null) send('book:open', id)
      })
  })

  void app.whenReady().then(async () => {
    const userData = app.getPath('userData')
    const coversDir = join(userData, 'covers')
    mkdirSync(coversDir, { recursive: true })
    store = new Store(join(userData, 'library.db'))

    Menu.setApplicationMenu(null)
    handleBookProtocol(store, coversDir)
    handleAppProtocol(join(import.meta.dirname, '../renderer'))
    // 'local-fonts' lets the appearance panel list the installed typefaces.
    const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'local-fonts'])
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(allowed.has(permission)),
    )
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))

    library = new Library(store, {
      changed: () => send('library:changed'),
      progress: progress => send('scan:progress', progress),
    })
    registerIpc({
      store,
      library,
      coversDir,
      notify: send,
      takeLaunchBook: () => {
        const book = launchBook
        launchBook = Promise.resolve(null)
        return book
      },
      isTrusted: event => {
        const frame = event.senderFrame
        return (
          !!frame &&
          !!mainWindow &&
          !mainWindow.isDestroyed() &&
          frame === mainWindow.webContents.mainFrame &&
          isAppUrl(frame.url)
        )
      },
    })

    const path = pathArgument(process.argv, process.cwd())
    if (path) launchBook = library.openPath(path).catch(() => null)

    createWindow()
    await library.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    void library?.stop()
    store?.close()
    store = null
  })
}
