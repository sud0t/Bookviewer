import type { Bridge } from '@shared/types'

/**
 * Arguments cross the context bridge by structured clone, which rejects the
 * proxies Svelte wraps reactive state in. Copy plain data out of them first.
 */
function plain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
  if (Array.isArray(value)) return value.map(plain) as T
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)])) as T
}

/** The typed bridge to the main process, exposed by the preload script. */
export const ipc: Bridge = {
  invoke: (channel, ...args) =>
    window.bridge.invoke(channel, ...(args.map(plain) as typeof args)),
  on: (event, listener) => window.bridge.on(event, listener),
}
