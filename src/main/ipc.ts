import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel, IpcHandlers } from '@shared/types'
import { removeCover, saveCover } from './covers'
import type { Store } from './db'
import type { Library } from './library'
import { dictionary, wikipedia } from './lookup'
import { downloadBook, fetchImage, fetchOpds } from './opds'
import { speak, voices } from './tts'
import { sanitizeFilename } from './util'

type Awaitable<T> = T | Promise<T>
type Handlers = {
  [K in IpcChannel]: (
    event: IpcMainInvokeEvent,
    ...args: Parameters<IpcHandlers[K]>
  ) => Awaitable<ReturnType<IpcHandlers[K]>>
}

export function openExternal(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:')
      void shell.openExternal(url)
  } catch {
    // not a URL
  }
}

interface Context {
  store: Store
  library: Library
  coversDir: string
  /** Whether a frame is the app's own UI (and so may call us). */
  isTrusted(event: IpcMainInvokeEvent): boolean
}

export function registerIpc({ store, library, coversDir, isTrusted }: Context): void {
  const windowOf = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)

  const handlers: Handlers = {
    'folders:list': () => library.listFolders(),
    'folders:add': async event => {
      const window = windowOf(event)
      const options = {
        title: 'Add folders to the library',
        properties: ['openDirectory', 'multiSelections'] as ('openDirectory' | 'multiSelections')[],
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled) return []
      return result.filePaths.flatMap(path => library.addFolder(path) ?? [])
    },
    'folders:addPath': (_event, path) => library.addFolder(String(path)),
    'folders:remove': (_event, id) => library.removeFolder(id),
    'folders:rescan': (_event, id) => library.rescan(id),

    'books:list': () => store.listBooks(),
    'books:get': (_event, id) => store.getBook(id),
    'books:setMeta': async (_event, id, meta, cover) => {
      // The id ends up in a file name: it has to be a real book's.
      if (!Number.isInteger(id) || !store.getBook(id)) return
      const saved = cover instanceof Uint8Array ? await saveCover(coversDir, id, cover) : false
      store.setMeta(id, meta, saved)
    },
    'books:setProgress': (_event, id, progress, location) =>
      store.setProgress(id, progress, String(location)),
    'books:opened': (_event, id) => store.markOpened(id),
    'books:manifest': (_event, id) => store.getManifest(id),
    'books:showInFolder': (_event, id) => {
      const book = store.getBook(id)
      if (book) shell.showItemInFolder(book.path)
    },
    'books:forget': async (_event, id) => {
      if (!Number.isInteger(id) || !store.getBook(id)) return
      store.forgetBook(id)
      await removeCover(coversDir, id)
    },

    'annotations:list': (_event, bookId) => store.listAnnotations(bookId),
    'annotations:add': (_event, annotation) => store.addAnnotation(annotation),
    'annotations:update': (_event, id, patch) => store.updateAnnotation(id, patch),
    'annotations:remove': (_event, id) => store.removeAnnotation(id),
    'annotations:export': async (event, bookId, format, content) => {
      const book = store.getBook(bookId)
      const extension = format === 'json' ? 'json' : 'md'
      const options = {
        title: 'Export annotations',
        defaultPath: `${sanitizeFilename(book?.title ?? 'annotations')}.${extension}`,
        filters: [
          format === 'json'
            ? { name: 'JSON', extensions: ['json'] }
            : { name: 'Markdown', extensions: ['md'] },
        ],
      }
      const window = windowOf(event)
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, String(content), 'utf8')
      return result.filePath
    },

    'bookmarks:list': (_event, bookId) => store.listBookmarks(bookId),
    'bookmarks:add': (_event, bookmark) => store.addBookmark(bookmark),
    'bookmarks:remove': (_event, id) => store.removeBookmark(id),

    'settings:get': () => store.getSettings(),
    'settings:set': (_event, patch) => store.setSettings(patch),

    'lookup:wikipedia': (_event, query, language) => wikipedia(String(query), String(language)),
    'lookup:dictionary': (_event, query, language) => dictionary(String(query), String(language)),

    'tts:voices': (_event, engine) => voices(engine, store.getSettings().piperModel),
    'tts:speak': (_event, engine, text, opts) => {
      const { piperPath, piperModel } = store.getSettings()
      return speak(engine, String(text), opts, { path: piperPath, model: piperModel })
    },

    'opds:catalogs': () => store.getCatalogs(),
    'opds:setCatalogs': (_event, catalogs) =>
      store.setCatalogs(
        catalogs
          .filter(c => typeof c?.url === 'string' && typeof c?.title === 'string')
          .map(c => ({ title: c.title, url: c.url })),
      ),
    'opds:fetch': (_event, url) => fetchOpds(String(url)),
    'opds:image': (_event, url) => fetchImage(String(url)),
    'opds:download': async (_event, url, folderId, suggestedName) => {
      const folder = store.getFolder(folderId)
      if (!folder) throw new Error('Unknown library folder')
      const path = await downloadBook(String(url), folder.path, String(suggestedName))
      void library.scan(folderId)
      return path
    },

    'shell:openExternal': (_event, url) => openExternal(String(url)),
    'window:setFullscreen': (event, on) => windowOf(event)?.setFullScreen(!!on),
    'window:setTitle': (event, title) => windowOf(event)?.setTitle(String(title)),
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrusted(event)) throw new Error(`Refused ${channel} from an untrusted frame`)
      return (handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown)(event, ...args)
    })
  }
}
