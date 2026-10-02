import {
  DEFAULT_SETTINGS,
  type Book,
  type Folder,
  type Settings,
  type ThemeName,
} from '@shared/types'
import { ipc } from './ipc'

const darkQuery = matchMedia('(prefers-color-scheme: dark)')

/** Global UI state. */
export const app = $state({
  ready: false,
  view: 'library' as 'library' | 'reader',
  bookId: null as number | null,
  books: [] as Book[],
  folders: [] as Folder[],
  settings: { ...DEFAULT_SETTINGS } as Settings,
  scanning: {} as Record<number, boolean>,
  systemDark: darkQuery.matches,
  fullscreen: false,
  toast: null as { message: string; kind: 'info' | 'error' } | null,
})

darkQuery.addEventListener('change', event => (app.systemDark = event.matches))

export function theme(): ThemeName {
  if (!app.settings.themeAuto) return app.settings.theme
  return app.systemDark ? 'dark' : 'light'
}

export const isDark = (name: ThemeName): boolean =>
  name === 'dark' || name === 'black' || name === 'gray'

export async function refreshLibrary(): Promise<void> {
  const [folders, books] = await Promise.all([ipc.invoke('folders:list'), ipc.invoke('books:list')])
  app.folders = folders
  app.books = books
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
  app.bookId = null
  void ipc.invoke('window:setTitle', 'BookViewer')
  void refreshLibrary()
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  app.toast = { message, kind }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (app.toast = null), kind === 'error' ? 6000 : 3000)
}

export async function initApp(): Promise<void> {
  app.settings = await ipc.invoke('settings:get')
  await refreshLibrary()
  ipc.on('library:changed', () => void refreshLibrary())
  ipc.on('scan:progress', ({ folderId, scanning }) => (app.scanning[folderId] = scanning))
  ipc.on('window:fullscreen', on => (app.fullscreen = on))
  app.ready = true
}
