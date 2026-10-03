import {
  DEFAULT_SETTINGS,
  type Book,
  type Folder,
  type Settings,
  type ThemeName,
} from '@shared/types'
import { ipc } from './ipc'

const darkQuery = matchMedia('(prefers-color-scheme: dark)')

export interface Toast {
  message: string
  kind: 'info' | 'error'
  /**
   * Something to do about what the toast reports. `undo` marks the ones that
   * take the reported change back (Ctrl+Z runs those, and only those).
   */
  action?: { label: string; run: () => void; undo?: boolean }
}

/** Global UI state. */
export const app = $state({
  ready: false,
  view: 'library' as 'library' | 'reader',
  bookId: null as number | null,
  /** The book that was open last, so the library can put focus back on it. */
  lastBookId: null as number | null,
  books: [] as Book[],
  folders: [] as Folder[],
  settings: { ...DEFAULT_SETTINGS } as Settings,
  scanning: {} as Record<number, boolean>,
  systemDark: darkQuery.matches,
  fullscreen: false,
  toast: null as Toast | null,
  /** Books taken out of the library list that could be put back. */
  hiddenBooks: 0,
})

darkQuery.addEventListener('change', event => (app.systemDark = event.matches))

export function theme(): ThemeName {
  if (!app.settings.themeAuto) return app.settings.theme
  return app.systemDark ? 'dark' : 'light'
}

export const isDark = (name: ThemeName): boolean =>
  name === 'dark' || name === 'black' || name === 'gray'

export async function refreshLibrary(): Promise<void> {
  const [folders, books, hidden] = await Promise.all([
    ipc.invoke('folders:list'),
    ipc.invoke('books:list'),
    ipc.invoke('books:hiddenCount'),
  ])
  app.folders = folders
  app.books = books
  app.hiddenBooks = hidden
}

/** Re-reads one book's row after its metadata or progress changed. */
export async function refreshBook(id: number): Promise<void> {
  const book = await ipc.invoke('books:get', id)
  const at = app.books.findIndex(b => b.id === id)
  if (book && at >= 0) app.books[at] = book
}

let pendingSettings: Partial<Settings> = {}
let settingsTimer: ReturnType<typeof setTimeout> | undefined

/** Applies a settings change at once and persists it shortly after. */
export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(app.settings, patch)
  Object.assign(pendingSettings, patch)
  clearTimeout(settingsTimer)
  settingsTimer = setTimeout(() => {
    const batch = pendingSettings
    pendingSettings = {}
    void ipc.invoke('settings:set', batch)
  }, 250)
}

export function openBook(id: number): void {
  app.bookId = id
  app.view = 'reader'
}

export function closeBook(): void {
  app.view = 'library'
  app.lastBookId = app.bookId
  app.bookId = null
  void ipc.invoke('window:setTitle', 'BookViewer')
  void refreshLibrary()
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export function toast(
  message: string,
  options: Toast['kind'] | { kind?: Toast['kind']; action?: Toast['action'] } = 'info',
): void {
  const { kind = 'info', action } = typeof options === 'string' ? { kind: options } : options
  app.toast = { message, kind, action }
  clearTimeout(toastTimer)
  // long enough to read, and to reach for the action when there is one
  const reading = 2500 + message.length * 45
  toastTimer = setTimeout(dismissToast, kind === 'error' ? 12000 : Math.max(action ? 7000 : 0, reading))
}

export function dismissToast(): void {
  clearTimeout(toastTimer)
  app.toast = null
}

/** Runs the action of the toast on screen, if it has one. */
export function runToastAction(): boolean {
  const action = app.toast?.action
  if (!action) return false
  dismissToast()
  action.run()
  return true
}

export async function initApp(): Promise<void> {
  app.settings = await ipc.invoke('settings:get')
  await refreshLibrary()
  ipc.on('library:changed', () => void refreshLibrary())
  ipc.on('scan:progress', ({ folderId, scanning }) => (app.scanning[folderId] = scanning))
  ipc.on('window:fullscreen', on => (app.fullscreen = on))
  ipc.on('book:open', id => void refreshLibrary().then(() => openBook(id)))
  app.ready = true
  const launched = await ipc.invoke('library:launchBook')
  if (launched != null) {
    await refreshLibrary()
    openBook(launched)
  }
}
