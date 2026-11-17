/**
 * Between the streaming app and the gfx apps it shows, beyond the picture:
 *
 * - Cue to stream: a gfx app's page passes a cued commercial (window.streamerCue),
 *   the main window asks to copy the video here (so a Wi-Fi hiccup can't stop it
 *   mid-air), and tells the gfx app how it goes (POST /api/cue).
 * - The Live picture: the main window hands small JPEGs of its Live picture, sent
 *   on to each gfx app (POST /api/program) for the gfx operator's On air screen.
 *
 * Only gfx apps whose page the streaming app shows are talked to.
 */
const { app } = require('electron')
const { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

/**
 * @param {Electron.IpcMain} ipcMain
 * @param {(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => boolean} fromMain
 * @param {(channel: string, payload: unknown) => void} send to the main window
 * @param {() => string[]} origins the gfx pages' origins shown now
 * @param {(sender: Electron.WebContents) => string | null} originOf a graphics page's origin, by its window
 */
function setupCue(ipcMain, fromMain, send, origins, originOf) {
  const known = (origin) => typeof origin === 'string' && origins().includes(origin)

  // A graphics page passes a cue (or its un-cueing). Its video must come from that page's own gfx app.
  ipcMain.handle('gfx:cue', (e, c) => {
    const origin = originOf(e.sender)
    if (!origin || !c || !Number.isInteger(c.take)) return false
    if (c.clear) return send('gfx:cue', { origin, take: c.take, clear: true }), true
    let url
    try {
      url = new URL(String(c.url))
    } catch {
      return false
    }
    if (url.origin !== origin || !/^\/media\/[\w-]+$/.test(url.pathname)) return false
    send('gfx:cue', { origin, take: c.take, name: String(c.name ?? 'Commercial').slice(0, 80), url: url.href })
    return true
  })

  // Copy the cued video to this PC. Returns its path here.
  ipcMain.handle('gfx:copy-cue', async (e, href) => {
    if (!fromMain(e)) throw new Error('Not allowed')
    const url = new URL(String(href))
    if (!known(url.origin) || !/^\/media\/[\w-]+$/.test(url.pathname)) throw new Error('Not from a gfx app shown here')
    const dir = join(app.getPath('userData'), 'commercials')
    mkdirSync(dir, { recursive: true })
    // Keep the last few, so a commercial can be played again without copying.
    const old = readdirSync(dir)
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of old.slice(8)) {
      try {
        unlinkSync(join(dir, f))
      } catch {
        // in use: next time
      }
    }
    const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
    if (!r.ok || !r.body) throw new Error(`The gfx app said ${r.status}`)
    const type = r.headers.get('content-type') ?? ''
    const ext = type.includes('webm') ? '.webm' : type.includes('quicktime') ? '.mov' : type.includes('matroska') ? '.mkv' : '.mp4'
    const file = join(dir, `cue-${Date.now()}${ext}`)
    await pipeline(Readable.fromWeb(r.body), createWriteStream(file))
    return file
  })

  // Tell a gfx app something: how the cue goes (JSON), or the Live picture (JPEG).
  const busy = new Set()
  const quietUntil = new Map()
  ipcMain.on('gfx:post', (e, m) => {
    if (!fromMain(e) || !m || !known(m.origin)) return
    const picture = m.path === '/api/program'
    if (!picture && m.path !== '/api/cue') return
    const key = `${m.origin}${m.path}`
    // Pictures: skip one while the last is still on its way, and pause after a failure.
    if (picture && (busy.has(key) || (quietUntil.get(key) ?? 0) > Date.now())) return
    busy.add(key)
    const body = picture ? Buffer.from(m.body) : JSON.stringify(m.body)
    fetch(m.origin + m.path, {
      method: 'POST',
      headers: { 'content-type': picture ? 'image/jpeg' : 'application/json' },
      body,
      signal: AbortSignal.timeout(picture ? 2000 : 5000)
    })
      .then((r) => {
        if (!r.ok) quietUntil.set(key, Date.now() + 5000)
      })
      .catch(() => quietUntil.set(key, Date.now() + 5000))
      .finally(() => busy.delete(key))
  })
}

module.exports = { setupCue }
