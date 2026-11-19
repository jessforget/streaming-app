/**
 * The desktop version: the same app in its own window, with the graphics card switched on.
 *
 *   npm run desktop
 *
 * It starts the app's server (exactly as `npm run serve` does), then opens the
 * main window in Electron instead of Chrome. Compared with a browser tab:
 *
 * - it asks Windows for the strong graphics card (the NVIDIA one on a laptop
 *   with two), so drawing and encoding run there, like OBS,
 * - it never slows down when the window is in the background or covered,
 * - cameras and microphones work without "Allow" prompts,
 * - screen capture shares the main screen, with the PC's sound,
 * - Graphics (network) sources work: web pages from a gfx app on another
 *   computer, drawn see-through over the cameras (graphics.cjs).
 *
 * Tablets, phones, the companion app and the stream deck connect to the same
 * server as before; nothing changes for them.
 */
const { app, BrowserWindow, dialog, session, desktopCapturer, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const http = require('node:http')
const { setupGraphics } = require('./graphics.cjs')

// Before the window opens: the strong graphics card, and no slowing down in the background.
app.commandLine.appendSwitch('force_high_performance_gpu')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
// Graphics pages that receive a window from the gfx app (WebRTC): use real network addresses, not hidden ".local" names some networks can't find.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')

const PORT = Number(process.env.STREAMING_CONTROL_PORT) || 7420
const ROOT = join(__dirname, '..')
let server = null

if (!app.requestSingleInstanceLock()) app.quit()

/** Run the app's server with Electron's own Node (no separate Node needed on the PC). */
function startServer() {
  const tsx = require.resolve('tsx/cli', { paths: [ROOT] })
  server = spawn(process.execPath, [tsx, join(ROOT, 'src/server/index.ts'), '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true
  })
  server.on('exit', (code) => {
    server = null
    if (!quitting) {
      dialog.showErrorBox('Streaming App', `The app's server stopped (code ${code}). Is the app already open in another window? Close it and start again.`)
      app.quit()
    }
  })
}

/** Wait until the server answers (it takes a few seconds the first time). */
function waitForServer(ms = 30000) {
  const until = Date.now() + ms
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1000 }, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => (Date.now() > until ? reject(new Error('The server did not start')) : setTimeout(tryOnce, 300)))
      req.on('timeout', () => req.destroy())
    }
    tryOnce()
  })
}

let quitting = false
let win = null
const graphics = setupGraphics(ipcMain, () => (win && !win.isDestroyed() ? win.webContents : null))

async function open() {
  const local = (url) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)
  // Cameras, microphones and the ATEM: allowed for the app's own page, no prompt.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    done(local(wc.getURL()) && ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission) => !!wc && local(wc.getURL()) && ['media'].includes(permission))
  // Screen capture: the main screen, with the PC's sound (Windows).
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, done) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    done(sources[0] ? { video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined } : {})
  })

  win = new BrowserWindow({
    width: 1600,
    height: 940,
    backgroundColor: '#0f1216',
    title: 'Streaming App',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, preload: join(__dirname, 'preload.cjs') }
  })
  // The hidden graphics windows don't count: closing the main window closes the app.
  win.on('closed', () => app.quit())
  // The page asks before closing while live or recording; show that question as a real dialog.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep the app open', 'Close and stop'],
      defaultId: 0,
      cancelId: 0,
      message: 'You are live or recording.',
      detail: 'Closing the app stops the stream and the recording.'
    })
    if (choice === 1) e.preventDefault()
  })
  await win.loadURL(`http://localhost:${PORT}/`)
}

app.whenReady().then(async () => {
  startServer()
  try {
    await waitForServer()
  } catch (e) {
    dialog.showErrorBox('Streaming App', `Could not start: ${e.message}. Run "npm install" and "npm run build" in the app folder, then try again.`)
    app.quit()
    return
  }
  await open()
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  quitting = true
  graphics.closeAll()
  if (server) server.kill()
})
