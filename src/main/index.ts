/**
 * Electron main process: starts the engine, the ATEM link, the controller
 * and the control server, then opens the main window.
 */
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { Controller, errorText } from '../core/controller'
import { SimAtem, SimEngine } from '../core/sim'
import type { AtemLink, Engine } from '../core/ports'
import { CommandError, DEFAULT_CONTROL_PORT } from '../shared/protocol'
import { NetworkAtemLink } from './atem/atemLink'
import { ObsEngine } from './engine/obsEngine'
import { ControlServer } from './control/server'
import { PairingManager } from './control/pairing'
import { DeviceFile, EncryptedKeyStore, SetupFile, files } from './storage'

let win: BrowserWindow | null = null
let controller: Controller | null = null
let server: ControlServer | null = null

function pickEngine(dataDir: string): { engine: Engine; note: string; mode: 'obs' | 'simulated' } {
  if (process.env.STREAMING_ENGINE !== 'simulated') {
    try {
      ObsEngine.load()
      return { engine: new ObsEngine(dataDir, app.getVersion()), mode: 'obs', note: 'Video engine ready' }
    } catch (e) {
      return { engine: new SimEngine(), mode: 'simulated', note: `Practice mode: ${errorText(e)}` }
    }
  }
  return { engine: new SimEngine(), mode: 'simulated', note: 'Practice mode: nothing is captured or sent' }
}

async function boot() {
  const dir = app.getPath('userData')
  const f = files(dir)
  const setup = new SetupFile(f.setup)
  const initial = setup.load()
  let picked = pickEngine(join(dir, 'obs'))
  const atem: AtemLink = process.env.STREAMING_ATEM === 'simulated' ? new SimAtem() : new NetworkAtemLink()
  const keys = new EncryptedKeyStore(f.keys, safeStorage)
  const pairing = new PairingManager(new DeviceFile(f.devices))

  const make = (engine: Engine) => new Controller({ engine, atem, keys, initial, devices: pairing })
  controller = make(picked.engine)
  try {
    await controller.start()
  } catch (e) {
    // The real engine failed to start: keep the app usable in practice mode.
    picked = { engine: new SimEngine(), mode: 'simulated', note: `Practice mode: ${errorText(e)}` }
    controller = make(picked.engine)
    await controller.start()
  }
  const c = controller
  c.state.engine = { mode: picked.mode, note: picked.note }
  if (process.env.STREAMING_ATEM === 'simulated') await atem.connect('simulated')

  pairing.onChange((s) => c.updateDevices(s))
  server = new ControlServer({
    controller: c,
    pairing,
    port: Number(process.env.STREAMING_CONTROL_PORT) || DEFAULT_CONTROL_PORT,
    staticDir: join(__dirname, '../renderer'),
    appVersion: app.getVersion()
  })
  try {
    await server.start()
    c.updateDevices({ ...pairing.snapshot(), controlUrl: server.urls()[0] })
  } catch (e) {
    c.updateDevices({ ...pairing.snapshot(), controlUrl: '' })
    console.error('Control server could not start:', errorText(e))
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  c.on('state', (s) => {
    win?.webContents.send('state', s)
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        setup.save(c.state)
      } catch (e) {
        console.error('Could not save setup:', errorText(e))
      }
    }, 500)
  })
  c.on('stats', (s) => win?.webContents.send('stats', s))
  c.on('error', (msg) => win?.webContents.send('notice', msg))

  ipcMain.handle('state', () => c.state)
  ipcMain.handle('command', async (_e, action: unknown, params: unknown) => {
    try {
      return { ok: true, data: await c.run('local', action, params) }
    } catch (e) {
      return { ok: false, error: e instanceof CommandError ? e.message : `Something went wrong: ${errorText(e)}` }
    }
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'Streaming App',
    backgroundColor: '#161615',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  await boot()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await server?.stop().catch(() => {})
  await controller?.stop().catch(() => {})
})
