import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Bridge } from '@shared/types'

const CHANNEL = /^[a-z]+:[A-Za-z]+$/
const EVENTS = new Set(['library:changed', 'scan:progress', 'window:fullscreen'])

const bridge: Bridge = {
  invoke(channel, ...args) {
    if (!CHANNEL.test(channel)) return Promise.reject(new Error(`Bad channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on(event, listener) {
    if (!EVENTS.has(event)) throw new Error(`Unknown event: ${event}`)
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload as never)
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('bridge', bridge)
