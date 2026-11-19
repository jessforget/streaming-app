/**
 * The gfx app for Windows: the operator's window on the graphics laptop.
 *
 *   npm run gfx            (or "Start Gfx App.bat")
 *
 * It runs the gfx app's server (server.cjs) inside, and opens the operator's
 * window: the rundown, Preview and On air, Take / Hide / Next. The streaming
 * app on the streaming PC loads this laptop's /live page as a Graphics
 * (network) source, best in its Overlay.
 *
 * Compared with the page in a browser, the window can also pick files, take
 * files dragged from Explorer, and send another window on this laptop
 * (PowerPoint, Word...) to the stream.
 */
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session } = require('electron')
const { join } = require('node:path')
const { readFileSync, writeFileSync } = require('node:fs')
const { startServer } = require('./server.cjs')
const firewall = require('./firewall.cjs')

// Its own name and settings folder (the show is saved there), apart from the streaming app's.
app.setName('Gfx app')
app.setPath('userData', join(app.getPath('appData'), 'Gfx app'))
if (!app.requestSingleInstanceLock()) app.quit()

// Keep the picture and timers running when the window is behind PowerPoint.
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
// Sending a window to the streaming PC: use this laptop's real network address, not a hidden ".local" name some networks can't find.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')

let win = null
let gfx = null
/** The window the page asked to send next (see setDisplayMediaRequestHandler). */
let nextCapture = null

async function open() {
  try {
    gfx = await startServer({ port: Number(process.env.GFX_PORT) || 8765, dataDir: app.getPath('userData') })
  } catch (e) {
    dialog.showErrorBox('Gfx app', `The gfx app could not start: ${e.message}`)
    return app.quit()
  }
  const origin = `http://localhost:${gfx.port}`
  // Only sending a window (screen capture) is allowed, and only to the gfx app's own window: no camera, microphone or anything else.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => done(permission === 'display-capture' && !!win && wc === win.webContents))
  // Sending a window: the page asks for the screen (getDisplayMedia) right after naming the window it wants.
  session.defaultSession.setDisplayMediaRequestHandler((_request, done) => {
    const source = nextCapture
    nextCapture = null
    if (!source) return done({})
    done({ video: source })
  })

  // Where it was last time (the same monitor, size and place), when that monitor is still there.
  // The first time on a PC with two monitors: the second one (the streaming app has the main one).
  const place = windowPlace()
  win = new BrowserWindow({
    ...place.bounds,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0e1014',
    title: 'Gfx app',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false }
  })
  if (place.maximized) win.maximize()
  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
    try {
      writeFileSync(PLACE_FILE(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }))
    } catch {
      // Not remembered; it still works.
    }
  }
  let saveTimer = null
  const later = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(remember, 500)
  }
  win.on('move', later)
  win.on('resize', later)
  win.on('maximize', remember)
  win.on('unmaximize', remember)
  win.on('close', remember)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => app.quit())
  await win.loadURL(`${origin}/app`)
  console.log(`Gfx app running. Add to the streaming app: ${gfx.addresses().map((a) => `http://${a}:${gfx.port}/live`).join('  or  ') || `http://<this laptop>:${gfx.port}/live`}`)
}

const PLACE_FILE = () => join(app.getPath('userData'), 'window.json')

/** Where to open the window: { bounds, maximized }. */
function windowPlace() {
  const displays = screen.getAllDisplays()
  const fits = (b) => displays.some((d) => {
    const a = d.workArea
    // Most of its title bar on a monitor that is still there.
    return b.x + 100 >= a.x && b.x + 100 <= a.x + a.width && b.y >= a.y - 10 && b.y + 30 <= a.y + a.height
  })
  try {
    const saved = JSON.parse(readFileSync(PLACE_FILE(), 'utf8'))
    const b = saved?.bounds
    if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && fits(b)) {
      return { bounds: { x: b.x, y: b.y, width: Math.max(1024, b.width), height: Math.max(640, b.height) }, maximized: !!saved.maximized }
    }
  } catch {
    // First time here.
  }
  const primary = screen.getPrimaryDisplay()
  const other = displays.find((d) => d.id !== primary.id)
  if (other) return { bounds: { ...other.workArea }, maximized: true }
  // One screen (a laptop): most of it, at least 1280 x 720.
  const a = primary.workArea
  const width = Math.max(1280, Math.min(1600, a.width))
  const height = Math.max(720, Math.min(900, a.height))
  return { bounds: { x: a.x + Math.max(0, (a.width - width) / 2), y: a.y + Math.max(0, (a.height - height) / 2), width, height }, maximized: a.width <= 1600 || a.height <= 900 }
}

const fromApp = (e) => win && e.sender === win.webContents

ipcMain.handle('gfx:pick', async (e, kind) => {
  if (!fromApp(e)) return []
  const video = kind === 'video'
  const r = await dialog.showOpenDialog(win, {
    title: video ? 'Pick videos' : 'Pick photos (or a folder of photos)',
    properties: video ? ['openFile', 'multiSelections'] : ['openFile', 'multiSelections'],
    filters: video ? [{ name: 'Videos', extensions: ['mp4', 'webm', 'mov', 'm4v', 'mkv'] }] : [{ name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }]
  })
  return r.canceled ? [] : r.filePaths
})

/** The windows open on this laptop (not this one). */
ipcMain.handle('gfx:windows', async (e) => {
  if (!fromApp(e)) return []
  // Windows, then whole screens (a PowerPoint slide show on a second screen is easiest sent as that screen).
  const get = (type) => desktopCapturer.getSources({ types: [type], thumbnailSize: { width: 0, height: 0 } }).catch(() => [])
  const windows = (await get('window')).filter((s) => !/^Gfx app$/.test(s.name) && s.name.trim())
  const screens = await get('screen')
  return [
    ...windows.map((s) => ({ id: s.id, name: s.name })),
    ...screens.map((s, i) => ({ id: s.id, name: `Whole screen ${screens.length > 1 ? i + 1 : ''}`.trim() }))
  ]
})

/** Get a window ready to send: by its id, or (after it was reopened) by its name. The page then asks for it. */
ipcMain.handle('gfx:findWindow', async (e, id, name) => {
  if (!fromApp(e)) return null
  // Windows and screens asked for apart: on some PCs one list fails, and a joint call then returns nothing.
  const get = (type) => desktopCapturer.getSources({ types: [type], thumbnailSize: { width: 0, height: 0 } }).catch(() => [])
  const list = [...(await get('window')), ...(await get('screen'))]
  const source = list.find((s) => s.id === id) ?? list.find((s) => s.name === name) ?? null
  nextCapture = source
  return source?.id ?? null
})

/** A small picture of a window or screen in the rundown (by id, or by name after it was reopened). */
ipcMain.handle('gfx:windowThumb', async (e, id, name) => {
  if (!fromApp(e)) return null
  const get = (type) => desktopCapturer.getSources({ types: [type], thumbnailSize: { width: 192, height: 108 } }).catch(() => [])
  const list = [...(await get('window')), ...(await get('screen'))]
  const s = list.find((x) => x.id === id) ?? list.find((x) => x.name === name)
  return s && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null
})

/** Can the streaming PC get past Windows Firewall to this app? 'allowed', 'blocked' or 'unknown'. */
ipcMain.handle('gfx:firewall', (e) => (fromApp(e) ? firewall.check() : 'unknown'))
/** Let PCs on this network in (Windows asks the person to confirm). */
ipcMain.handle('gfx:firewall-allow', (e) => (fromApp(e) ? firewall.allow() : 'unknown'))

app.whenReady().then(open)
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})
app.on('before-quit', () => gfx?.close())
app.on('window-all-closed', () => app.quit())
