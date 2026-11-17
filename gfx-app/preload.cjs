/** What the gfx app window adds to its page: picking files, dropped files' paths, and the windows it can send. */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('gfxDesktop', {
  /** 'video' or 'photos': the files the person picks. */
  pickFiles: (kind) => ipcRenderer.invoke('gfx:pick', kind),
  /** A file dragged in from Explorer: its path on this laptop. */
  pathFor: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  listWindows: () => ipcRenderer.invoke('gfx:windows'),
  findWindow: (id, name) => ipcRenderer.invoke('gfx:findWindow', id, name)
})
