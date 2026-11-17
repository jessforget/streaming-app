/**
 * Graphics (network) sources, in the desktop version.
 *
 * Each graphics page (from the gfx app on another computer) is loaded in a
 * hidden, see-through window that is never shown on screen. Every time the
 * page changes, the changed part of its picture is handed to the main window,
 * which layers it over the cameras like any other source.
 *
 * Only the changed part is sent, so a still lower third costs nothing, and an
 * animation costs only the area that moves.
 *
 * If the gfx laptop can't be reached, the source shows nothing (see-through)
 * and we try again every few seconds; when it is back, the page loads again.
 *
 * The page is told when it goes on the stream and when it comes off (a scene
 * with it goes live, or the Overlay is switched on), so it can play its
 * animation, or start its video, at that moment:
 *
 *   window.streamerLive                 true while on the stream
 *   'streamer:live' event on window     event.detail.live = true / false
 *
 * Sound: the page itself plays nothing out loud. It can send its sound (a
 * video's) to the mixer with window.streamerAudio.connect(offerSdp), a WebRTC
 * connection inside this PC (see graphics-preload.cjs).
 */
const { BrowserWindow, session } = require('electron')
const { join } = require('node:path')
const http = require('node:http')
const https = require('node:https')

const CHECK_MS = 5000
/** Two missed checks in a row (10 seconds) before the graphics are taken off. */
const MISSES = 2

/** The graphics pages get their own session: no cookies or permissions shared with the app's own page. */
let gfxSession = null
function getSession() {
  if (gfxSession) return gfxSession
  gfxSession = session.fromPartition('graphics')
  // A graphics page gets no camera, microphone, notifications, location or anything else.
  gfxSession.setPermissionRequestHandler((_wc, _permission, done) => done(false))
  gfxSession.setPermissionCheckHandler(() => false)
  return gfxSession
}

/** Does anything answer at this address? Any reply counts (even "not found"): the laptop is there. */
function reachable(url) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(url)
    } catch {
      return resolve(false)
    }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null
    if (!lib) return resolve(false)
    const req = lib.request(u, { method: 'GET', timeout: 3000, rejectUnauthorized: false }, (res) => {
      res.destroy()
      resolve(true)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(false))
    req.end()
  })
}

class GraphicsFeed {
  /**
   * @param {string} id
   * @param {{ url: string, width: number, height: number, fps: number }} opts
   * @param {(channel: string, payload: unknown) => void} send
   */
  constructor(id, opts, send) {
    this.id = id
    this.opts = opts
    this.send = send
    this.status = 'loading'
    this.live = !!opts.live
    this.misses = 0
    this.closed = false
    this.loaded = false
    this.win = new BrowserWindow({
      show: false,
      width: opts.width,
      height: opts.height,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
        session: getSession(),
        // Only gives the page window.streamerAudio, to send its sound to the mixer.
        preload: join(__dirname, 'graphics-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    const wc = this.win.webContents
    // Graphics pages are silent: sound stays on the mixer.
    wc.setAudioMuted(true)
    wc.setFrameRate(opts.fps)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('paint', (_e, dirty, image) => this.paint(dirty, image))
    wc.on('did-finish-load', () => {
      this.loaded = true
      this.misses = 0
      this.setStatus('connected')
      this.tellLive()
      // Ask for one whole picture, so the main window starts from the full page.
      wc.invalidate()
    })
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3: the load was replaced by another one, not a failure
      this.takeOff()
    })
    wc.on('render-process-gone', () => this.takeOff())
    this.load()
    this.timer = setInterval(() => void this.check(), CHECK_MS)
  }

  load() {
    if (this.closed) return
    this.loaded = false
    if (this.status !== 'unreachable') this.setStatus('loading')
    this.win.webContents.loadURL(this.opts.url).catch(() => {
      // did-fail-load reports it
    })
  }

  /** The page could not be reached: show nothing, and try again with the next check. */
  takeOff() {
    if (this.closed) return
    this.loaded = false
    this.setStatus('unreachable')
    this.send('gfx:clear', { id: this.id })
  }

  async check() {
    if (this.closed) return
    const ok = await reachable(this.opts.url)
    if (this.closed) return
    if (ok) {
      this.misses = 0
      if (this.status === 'unreachable') this.load()
      return
    }
    this.misses++
    if (this.misses >= MISSES && this.status !== 'unreachable') {
      // The page may still be on screen, but nobody can control it any more: take it off.
      // (It stays loaded but unseen; it loads afresh when the laptop is back.)
      this.win.webContents.stop()
      this.takeOff()
    }
  }

  /** On the stream now, or not. The page hears it at once (and again after each load). */
  setLive(live) {
    if (this.live === live) return
    this.live = live
    if (this.loaded) this.tellLive()
  }

  tellLive() {
    if (this.closed || this.win.isDestroyed()) return
    const live = this.live ? 'true' : 'false'
    this.win.webContents
      .executeJavaScript(`window.streamerLive = ${live}; window.dispatchEvent(new CustomEvent('streamer:live', { detail: { live: ${live} } })); 0`)
      .catch(() => {})
  }

  setStatus(status) {
    if (this.status === status && status !== 'loading') return
    this.status = status
    this.send('gfx:status', { id: this.id, status })
  }

  paint(dirty, image) {
    if (this.closed || !this.loaded || image.isEmpty()) return
    const size = image.getSize()
    // The picture may come at a different scale than the page (Windows display scaling).
    const kx = size.width / this.opts.width
    const ky = size.height / this.opts.height
    const x = Math.max(0, Math.floor(dirty.x * kx))
    const y = Math.max(0, Math.floor(dirty.y * ky))
    const w = Math.min(size.width - x, Math.ceil(dirty.width * kx))
    const h = Math.min(size.height - y, Math.ceil(dirty.height * ky))
    if (w <= 0 || h <= 0) return
    const part = w === size.width && h === size.height ? image : image.crop({ x, y, width: w, height: h })
    const ps = part.getSize()
    // BGRA, premultiplied alpha (how Chromium hands it out); the main window converts it.
    this.send('gfx:frame', { id: this.id, x, y, w: ps.width, h: ps.height, fw: size.width, fh: size.height, data: part.toBitmap() })
  }

  reload() {
    if (this.closed) return
    this.misses = 0
    this.load()
  }

  close() {
    this.closed = true
    clearInterval(this.timer)
    if (!this.win.isDestroyed()) this.win.destroy()
  }
}

/**
 * Connect the graphics pages to the main window's page.
 * @param {Electron.IpcMain} ipcMain
 * @param {() => Electron.WebContents | null} target the main window's page
 */
function setupGraphics(ipcMain, target) {
  /** @type {Map<string, GraphicsFeed>} */
  const feeds = new Map()
  const send = (channel, payload) => {
    const wc = target()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
  const fromMain = (e) => e.sender === target()
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)

  /** Open one page, or keep it if it is already open with the same settings. */
  const open = (p) => {
    if (!p || typeof p.id !== 'string' || typeof p.url !== 'string') return
    const opts = {
      url: p.url,
      width: clamp(p.width, 320, 3840, 1920),
      height: clamp(p.height, 180, 2160, 1080),
      fps: clamp(p.fps, 1, 60, 30),
      live: p.live === true
    }
    const have = feeds.get(p.id)
    if (have) {
      const o = have.opts
      if (o.url === opts.url && o.width === opts.width && o.height === opts.height && o.fps === opts.fps) {
        have.setLive(opts.live)
        // Same page again (the main window reloaded, or it went on or off the stream): send its status and a whole picture.
        send('gfx:status', { id: p.id, status: have.status })
        if (!have.win.isDestroyed()) have.win.webContents.invalidate()
        return
      }
      have.close()
      feeds.delete(p.id)
    }
    if (!/^https?:\/\//i.test(opts.url)) return send('gfx:status', { id: p.id, status: 'unreachable' })
    feeds.set(p.id, new GraphicsFeed(p.id, opts, send))
  }

  // The main window sends the whole list of pages it needs; pages not in it are closed.
  ipcMain.on('gfx:sync', (e, list) => {
    if (!fromMain(e) || !Array.isArray(list)) return
    const keep = new Set()
    for (const p of list.slice(0, 16)) {
      open(p)
      if (p && typeof p.id === 'string') keep.add(p.id)
    }
    for (const [id, f] of feeds) {
      if (keep.has(id)) continue
      f.close()
      feeds.delete(id)
    }
  })
  // A page sends its sound: pass its offer to the main window, and the answer back.
  let audioReq = 1
  const pendingAudio = new Map()
  ipcMain.handle('gfx:audio-offer', (e, sdp) => {
    const feed = [...feeds.values()].find((f) => !f.win.isDestroyed() && f.win.webContents === e.sender)
    if (!feed || typeof sdp !== 'string' || sdp.length > 100_000) throw new Error('Not a graphics page')
    const req = audioReq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingAudio.delete(req)
        reject(new Error('The streaming app did not answer'))
      }, 10_000)
      pendingAudio.set(req, (answer) => {
        clearTimeout(timer)
        if (typeof answer?.sdp === 'string') resolve(answer.sdp)
        else reject(new Error(answer?.error || 'No answer'))
      })
      send('gfx:audio-offer', { id: feed.id, req, sdp })
    })
  })
  ipcMain.on('gfx:audio-answer', (e, answer) => {
    if (!fromMain(e) || !answer) return
    const done = pendingAudio.get(answer.req)
    pendingAudio.delete(answer.req)
    done?.(answer)
  })
  require('./gfxfind.cjs').setupFind(ipcMain, fromMain)
  // A page hands a video over: the main window plays it from the gfx app (/media/...) itself.
  ipcMain.handle('gfx:video', (e, v) => {
    const feed = [...feeds.values()].find((f) => !f.win.isDestroyed() && f.win.webContents === e.sender)
    if (!feed || !v || typeof v.take !== 'string' || v.take.length > 200) throw new Error('Not a graphics page')
    if (v.stop) {
      send('gfx:video', { id: feed.id, take: v.take, stop: true })
      return true
    }
    let u
    try {
      u = new URL(v.url)
    } catch {
      throw new Error('Not a video address')
    }
    if (u.origin !== originOf(feed.opts.url) || !u.pathname.startsWith('/media/')) throw new Error('The video must come from the gfx app')
    send('gfx:video', { id: feed.id, take: v.take, url: u.href, shows: v.shows === 'box' ? 'box' : 'full', loop: v.loop === true, sound: v.sound !== false })
    return true
  })
  ipcMain.on('gfx:video-ended', (e, m) => {
    if (!fromMain(e) || !m) return
    const feed = feeds.get(m.id)
    if (feed && !feed.win.isDestroyed()) feed.win.webContents.send('gfx:video-ended', String(m.take))
  })
  const originOf = (url) => {
    try {
      return new URL(url).origin
    } catch {
      return null
    }
  }
  require('./gfxcue.cjs').setupCue(
    ipcMain,
    fromMain,
    send,
    () => [...new Set([...feeds.values()].map((f) => originOf(f.opts.url)).filter(Boolean))],
    (sender) => {
      const feed = [...feeds.values()].find((f) => !f.win.isDestroyed() && f.win.webContents === sender)
      return feed ? originOf(feed.opts.url) : null
    }
  )
  ipcMain.on('gfx:reload', (e, id) => {
    if (!fromMain(e)) return
    feeds.get(id)?.reload()
  })
  return {
    closeAll() {
      for (const f of feeds.values()) f.close()
      feeds.clear()
    }
  }
}

module.exports = { setupGraphics }
