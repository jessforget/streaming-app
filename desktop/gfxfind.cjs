/**
 * "Find gfx apps on the network" and "Test", for a Graphics (network) source.
 *
 * Find asks every address on this PC's own network (the x in 192.168.101.x, so
 * at most 254 per network) for the gfx app's /api/info, a few at a time, and
 * lists the gfx apps that answer. Test asks one address. Both run here, in the
 * desktop app's main process: no browser rules about other sites apply.
 */
const os = require('node:os')

const PORTS = [8765, 8766, 8767]

/** The /24 networks this PC is on (Wi-Fi, cable), e.g. ['192.168.101']. Never the internet. */
function localNets() {
  const nets = new Set()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (!/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address)) continue // only private networks
      nets.add(a.address.split('.').slice(0, 3).join('.'))
    }
  }
  return [...nets]
}

/** The gfx app's info at host:port, or null. */
async function info(host, port, ms) {
  try {
    const r = await fetch(`http://${host}:${port}/api/info`, { signal: AbortSignal.timeout(ms), redirect: 'error' })
    if (!r.ok) return { answered: true, gfx: null }
    const j = await r.json().catch(() => null)
    // Gfx apps from before 17 Nov don't say app: 'gfx-app' yet; their /api/info has port and addresses.
    const isGfx = j && (j.app === 'gfx-app' || (Number.isInteger(j.port) && Array.isArray(j.addresses)))
    return { answered: true, gfx: isGfx ? j : null }
  } catch (e) {
    // Refused = a PC is there, just nothing on that port; a timeout = probably no PC at all.
    return { answered: false, alive: e?.cause?.code === 'ECONNREFUSED', gfx: null }
  }
}

/**
 * Look on this PC's networks. onFound({ name, host, port, items, url }) for each gfx app;
 * onProgress({ checked, total, nets }). Stops early when signal aborts.
 */
async function find({ onFound, onProgress, signal, nets = localNets() }) {
  const hosts = ['127.0.0.1']
  for (const n of nets) for (let i = 1; i <= 254; i++) hosts.push(`${n}.${i}`)
  const total = hosts.length
  let checked = 0
  const seen = new Set()
  let next = 0
  const worker = async () => {
    while (next < hosts.length && !signal.aborted) {
      const host = hosts[next++]
      // The usual port first; the others only matter when 8765 was taken on that PC.
      for (const port of PORTS) {
        const r = await info(host, port, host === '127.0.0.1' ? 500 : 1500)
        if (r.gfx) {
          const name = String(r.gfx.name || host).slice(0, 80)
          const key = `${name}|${port}`
          // This PC answers on 127.0.0.1 (checked first) and on its network address: list it once.
          if (!seen.has(key)) {
            seen.add(key)
            onFound({ name, host, port, items: Number(r.gfx.items) || 0, local: host === '127.0.0.1', url: `http://${host}:${port}/live` })
          }
          break
        }
        if (!r.answered && !r.alive) break // no PC at that address: don't wait on the other ports
      }
      checked++
      if (checked % 8 === 0 || checked === total) onProgress({ checked, total, nets })
    }
  }
  await Promise.all(Array.from({ length: 48 }, worker))
  onProgress({ checked, total, nets, done: true })
}

/**
 * Test one address: 'connected' (a gfx app; with its name and how long it took),
 * 'page' (some other web page that loads), 'other' (something answered, not a page),
 * or 'unreachable'.
 */
async function test(url) {
  let u
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`)
  } catch {
    return { result: 'unreachable', why: 'That isn’t an address' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { result: 'unreachable', why: 'Use an http:// address' }
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  const t0 = Date.now()
  const r = await info(u.hostname, port, 3000)
  const ms = Date.now() - t0
  if (r.gfx) return { result: 'connected', name: String(r.gfx.name || u.hostname).slice(0, 80), ms, items: Number(r.gfx.items) || 0 }
  try {
    const p = await fetch(u.href, { signal: AbortSignal.timeout(4000) })
    return { result: p.ok ? 'page' : 'other', ms: Date.now() - t0, status: p.status }
  } catch {
    return { result: r.answered ? 'other' : 'unreachable', host: `${u.hostname}:${port}` }
  }
}

/**
 * Wire up to the main window's page.
 * @param {Electron.IpcMain} ipcMain
 * @param {(e: Electron.IpcMainInvokeEvent) => boolean} fromMain
 */
function setupFind(ipcMain, fromMain) {
  let running = null
  ipcMain.handle('gfx:test', (e, url) => (fromMain(e) && typeof url === 'string' && url.length < 2000 ? test(url) : { result: 'unreachable' }))
  ipcMain.handle('gfx:find', async (e) => {
    if (!fromMain(e)) return []
    running?.abort()
    const ctl = new AbortController()
    running = ctl
    const wc = e.sender
    const say = (channel, payload) => !wc.isDestroyed() && !ctl.signal.aborted && wc.send(channel, payload)
    const found = []
    await find({
      signal: ctl.signal,
      onFound: (f) => {
        found.push(f)
        say('gfx:find-found', f)
      },
      onProgress: (p) => say('gfx:find-progress', p)
    })
    if (running === ctl) running = null
    return found
  })
  // The gfx app on this PC (one operator, two monitors): start it, or bring its window forward when it already runs.
  ipcMain.handle('gfx:open-app', (e) => {
    if (!fromMain(e)) return { ok: false }
    return openGfxApp()
  })
  ipcMain.on('gfx:find-stop', (e) => {
    if (!fromMain(e)) return
    running?.abort()
    running = null
  })
}

/**
 * Start the gfx app on this PC with the same Electron as the streaming app. It is a
 * program of its own (it keeps running when the streaming app closes); started again,
 * it just brings its window forward (single instance).
 */
function openGfxApp() {
  const { app } = require('electron')
  const { spawn } = require('node:child_process')
  const { existsSync } = require('node:fs')
  const path = require('node:path')
  const main = path.join(__dirname, '..', 'gfx-app', 'main.cjs')
  if (app.isPackaged || !existsSync(main)) return { ok: false, why: 'The gfx-app folder isn’t next to this app. Start it with “Start Gfx App.bat”.' }
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    // Started the same way as this app (e.g. --no-sandbox where that is needed).
    const flags = process.argv.filter((a) => a === '--no-sandbox')
    const child = spawn(process.execPath, [...flags, main], { cwd: path.join(__dirname, '..'), detached: true, stdio: 'ignore', env })
    child.on('error', () => {})
    child.unref()
    return { ok: true, url: 'http://127.0.0.1:8765/live' }
  } catch (err) {
    return { ok: false, why: String(err?.message || err) }
  }
}

module.exports = { setupFind, find, test, localNets, openGfxApp }
