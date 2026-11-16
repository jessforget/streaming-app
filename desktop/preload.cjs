/**
 * What the desktop version adds to the main window's page: graphics pages from
 * the network (see graphics.cjs). The web version doesn't have this, so the
 * page checks for `window.desktopGraphics` before using it.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopGraphics', {
  /** The pages the main window needs now: [{ id, url, width, height, fps }]. Others are closed. */
  sync: (list) => ipcRenderer.send('gfx:sync', list),
  reload: (id) => ipcRenderer.send('gfx:reload', id),
  onFrame: (fn) => {
    const h = (_e, f) => fn(f)
    ipcRenderer.on('gfx:frame', h)
    return () => ipcRenderer.off('gfx:frame', h)
  },
  onStatus: (fn) => {
    const h = (_e, s) => fn(s)
    ipcRenderer.on('gfx:status', h)
    return () => ipcRenderer.off('gfx:status', h)
  },
  onClear: (fn) => {
    const h = (_e, s) => fn(s)
    ipcRenderer.on('gfx:clear', h)
    return () => ipcRenderer.off('gfx:clear', h)
  }
})
