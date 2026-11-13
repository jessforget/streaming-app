import { contextBridge, ipcRenderer } from 'electron'

/** The only door between the interface and the rest of the app. */
contextBridge.exposeInMainWorld('streamingApp', {
  getState: () => ipcRenderer.invoke('state'),
  command: (action: string, params?: unknown) => ipcRenderer.invoke('command', action, params),
  onState: (fn: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => fn(s)
    ipcRenderer.on('state', h)
    return () => ipcRenderer.off('state', h)
  },
  onStats: (fn: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => fn(s)
    ipcRenderer.on('stats', h)
    return () => ipcRenderer.off('stats', h)
  },
  onNotice: (fn: (msg: string) => void) => {
    const h = (_: unknown, m: string) => fn(m)
    ipcRenderer.on('notice', h)
    return () => ipcRenderer.off('notice', h)
  }
})
