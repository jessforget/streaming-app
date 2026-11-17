/**
 * The gfx app's server: it holds the rundown (lower thirds, videos, photos,
 * windows), what is in Preview and what is on air, and serves:
 *
 *   /live          the graphics page. Add its address in the streaming app as a
 *                  "Graphics (network)" source (best in its Overlay). See-through.
 *   /app           the operator's page (the gfx app window shows it; a browser works too).
 *   /events        Server-Sent Events: the state, to every page, at once.
 *   /media/...     the video and photo files in the rundown (only those).
 *   /api/...       changes from the operator's page.
 *
 * The streaming app tells the graphics page when it goes on and off the stream;
 * the page tells this server, so an item set to "start when live" animates in,
 * or starts playing, at that moment.
 *
 * Run it on its own (no window, no window capture):  node gfx-app/server.cjs [--port 8765] [--open]
 * Or as the Windows app (gfx-app/main.cjs), which runs this inside.
 *
 * No packages needed: plain Node.js.
 */
const http = require('node:http')
const { createReadStream, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } = require('node:fs')
const { join, extname, basename, dirname } = require('node:path')
const os = require('node:os')

const KINDS = ['lowerthird', 'video', 'photos', 'window']
const STYLES = ['classic', 'block', 'minimal', 'news']
const FONTS = ['Inter', 'Space Grotesk', 'Montserrat', 'Roboto Slab', 'custom']
const POSITIONS = ['left', 'center', 'right']
const ANIMATIONS = ['slide', 'fade', 'wipe']
const SHOWS = ['full', 'box']
const VIDEO_ENDS = ['loop', 'hide', 'hold']
const PHOTO_ENDS = ['loop', 'hold', 'hide']
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.mkv']
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']
const TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
}

const DEFAULT_LOOK = {
  style: 'classic',
  font: 'Inter',
  /** A font installed on the streaming PC (the page is drawn there), when font is 'custom'. */
  customFont: '',
  position: 'left',
  /** Pixels on a 1920 x 1080 picture. */
  nameSize: 52,
  titleSize: 30,
  /** 0 = as long as the words; 1 to 100 = that share of the picture's width. */
  length: 0,
  accent: '#2563d9',
  box: '#f2f2f2',
  text: '#111111',
  /** Seconds before a lower third hides by itself; 0 = until Hide is pressed. */
  stayFor: 0,
  animation: 'slide'
}

const isVideoFile = (p) => VIDEO_EXT.includes(extname(p).toLowerCase())
const isImageFile = (p) => IMAGE_EXT.includes(extname(p).toLowerCase())

/** Only known values get through; anything else keeps what it was. */
function cleanLook(p, was) {
  const pick = (k, list) => (list.includes(p[k]) ? p[k] : was[k])
  const num = (k, lo, hi) => (Number.isFinite(p[k]) ? Math.min(hi, Math.max(lo, Math.round(p[k]))) : was[k])
  const color = (k) => (typeof p[k] === 'string' && /^#[0-9a-f]{6}$/i.test(p[k]) ? p[k] : was[k])
  return {
    style: pick('style', STYLES),
    font: pick('font', FONTS),
    customFont: typeof p.customFont === 'string' ? p.customFont.replace(/[^\w \-]/g, '').slice(0, 60) : was.customFont,
    position: pick('position', POSITIONS),
    nameSize: num('nameSize', 20, 120),
    titleSize: num('titleSize', 12, 80),
    length: num('length', 0, 100),
    accent: color('accent'),
    box: color('box'),
    text: color('text'),
    stayFor: num('stayFor', 0, 600),
    animation: pick('animation', ANIMATIONS)
  }
}

const text = (v, max, d = '') => (typeof v === 'string' ? v.slice(0, max) : d)
const pickOf = (v, list, d) => (list.includes(v) ? v : d)
const numOf = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** One rundown item from what was sent, over what it was (or a fresh one). Paths are checked by the caller. */
function cleanItem(p, was) {
  const kind = was ? was.kind : pickOf(p.kind, KINDS, null)
  if (!kind) throw new Error('kind must be lowerthird, video, photos or window')
  const base = was ?? { id: '', kind, playOnLive: true }
  const item = { ...base }
  if (p.name !== undefined) item.name = text(p.name, 80)
  if (p.playOnLive !== undefined) item.playOnLive = p.playOnLive === true
  if (kind === 'lowerthird') {
    if (p.title !== undefined) item.title = text(p.title, 120)
    item.name ??= ''
    item.title ??= ''
  }
  if (kind === 'video') {
    if (p.shows !== undefined) item.shows = pickOf(p.shows, SHOWS, item.shows ?? 'full')
    if (p.end !== undefined) item.end = pickOf(p.end, VIDEO_ENDS, item.end ?? 'loop')
    if (p.sound !== undefined) item.sound = p.sound !== false
    item.shows ??= 'full'
    item.end ??= 'loop'
    item.sound ??= true
  }
  if (kind === 'photos') {
    if (p.seconds !== undefined) item.seconds = numOf(p.seconds, 1, 600, item.seconds ?? 5)
    if (p.fade !== undefined) item.fade = p.fade === true
    if (p.end !== undefined) item.end = pickOf(p.end, PHOTO_ENDS, item.end ?? 'loop')
    if (p.shows !== undefined) item.shows = pickOf(p.shows, SHOWS, item.shows ?? 'full')
    item.seconds ??= 5
    item.fade ??= true
    item.end ??= 'loop'
    item.shows ??= 'full'
  }
  if (kind === 'window') {
    if (p.sourceId !== undefined) item.sourceId = text(p.sourceId, 200)
    if (p.windowName !== undefined) item.windowName = text(p.windowName, 200)
    if (p.shows !== undefined) item.shows = pickOf(p.shows, SHOWS, item.shows ?? 'full')
    item.shows ??= 'full'
  }
  if (!item.name) item.name = kind === 'lowerthird' ? 'Lower third' : kind === 'video' ? 'Video' : kind === 'photos' ? 'Photos' : 'Window'
  return item
}

/**
 * Start the gfx app's server.
 * @param {{ port?: number, dataDir?: string, pagesDir?: string, log?: (s: string) => void }} opts
 * @returns {Promise<{ port: number, server: http.Server, addresses: () => string[], close: () => void }>}
 */
function startServer(opts = {}) {
  const pagesDir = opts.pagesDir ?? __dirname
  const dataDir = opts.dataDir ?? __dirname
  const SAVED = join(dataDir, 'gfx-show.json')
  const log = opts.log ?? ((s) => console.log(s))

  /** The show: the rundown, the lower thirds' look, Preview and On air. */
  let show = { items: [], look: { ...DEFAULT_LOOK }, previewId: null, onAir: null }
  let nextId = 1
  try {
    const saved = JSON.parse(readFileSync(SAVED, 'utf8'))
    const items = Array.isArray(saved.items) ? saved.items : []
    for (const raw of items) {
      try {
        const it = cleanItem(raw, null)
        it.id = typeof raw.id === 'string' ? raw.id : `item-${nextId}`
        if (it.kind === 'video') it.path = typeof raw.path === 'string' ? raw.path : ''
        if (it.kind === 'photos') it.paths = Array.isArray(raw.paths) ? raw.paths.filter((x) => typeof x === 'string') : []
        show.items.push(it)
      } catch {
        // skip an item we can't read
      }
    }
    for (const it of show.items) {
      const n = Number(/^item-(\d+)$/.exec(it.id)?.[1])
      if (n >= nextId) nextId = n + 1
    }
    show.look = cleanLook(saved.look ?? {}, DEFAULT_LOOK)
    show.previewId = show.items.some((i) => i.id === saved.previewId) ? saved.previewId : show.items[0]?.id ?? null
  } catch {
    // First start: a lower third to begin with.
    show.items.push({ id: 'item-1', kind: 'lowerthird', name: 'Sam Rivera', title: 'Guest speaker', playOnLive: true })
    show.previewId = 'item-1'
    nextId = 2
  }

  /** The streaming app's graphics pages that are connected, and whether the stream has them live. */
  const streamPages = new Set()
  let streamLive = false
  /** Pages listening for changes, and operator pages (they answer window-capture requests). */
  const listeners = new Set()
  const operators = new Set()
  /** Window-capture requests from graphics pages, waiting for the operator's answer. */
  const pendingRtc = new Map()
  let rtcId = 1
  let hideTimer = null
  let take = 0

  const save = () => {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(SAVED, JSON.stringify({ items: show.items, look: show.look, previewId: show.previewId }, null, 2))
    } catch (e) {
      log(`Could not save the show: ${e.message}`)
    }
  }

  const item = (id) => show.items.find((i) => i.id === id) ?? null
  /** What every page gets: no file paths, just names (the files come from /media). */
  const publicItem = (i) => {
    if (!i) return null
    const out = { ...i }
    if (i.kind === 'video') {
      out.file = i.path ? basename(i.path) : ''
      out.ok = !!i.path && exists(i.path)
      delete out.path
    }
    if (i.kind === 'photos') {
      out.count = i.paths.length
      out.files = i.paths.map((p) => basename(p))
      delete out.paths
    }
    return out
  }
  const snapshot = () => ({
    type: 'state',
    items: show.items.map(publicItem),
    look: show.look,
    previewId: show.previewId,
    onAir: show.onAir,
    stream: { connected: streamPages.size > 0, live: streamPages.size > 0 && streamLive }
  })
  const send = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`)
  const broadcast = () => {
    const msg = snapshot()
    for (const res of listeners) send(res, msg)
  }
  const changed = () => {
    save()
    broadcast()
  }

  function takeItem(id) {
    const it = item(id)
    if (!it) throw new Error('No such item')
    take++
    show.onAir = { id: it.id, take }
    clearTimeout(hideTimer)
    if (it.kind === 'lowerthird' && show.look.stayFor > 0) {
      hideTimer = setTimeout(() => {
        if (show.onAir?.take !== take) return
        show.onAir = null
        broadcast()
      }, show.look.stayFor * 1000)
    }
  }

  function addItem(p, local) {
    const it = cleanItem(p, null)
    it.id = `item-${nextId++}`
    if (it.kind === 'video') {
      if (!local) throw new Error('Videos are added on the gfx laptop itself')
      it.path = text(p.path, 1000)
      if (!it.path || !isVideoFile(it.path)) throw new Error('Pick a video file (mp4, webm, mov)')
      if (!p.name) it.name = basename(it.path, extname(it.path))
    }
    if (it.kind === 'photos') {
      if (!local) throw new Error('Photos are added on the gfx laptop itself')
      it.paths = photoPaths(p.paths)
      if (!it.paths.length) throw new Error('Pick some photos (jpg, png, webp)')
      if (!p.name) it.name = it.paths.length === 1 ? basename(it.paths[0], extname(it.paths[0])) : basename(dirname(it.paths[0])) || 'Photos'
    }
    const at = show.items.findIndex((i) => i.id === show.previewId)
    show.items.splice(at >= 0 ? at + 1 : show.items.length, 0, it)
    if (!show.previewId) show.previewId = it.id
    return it
  }

  /** Photo files from a list of files and folders (a folder adds its pictures, sorted by name). */
  function photoPaths(list) {
    const out = []
    for (const p of Array.isArray(list) ? list.slice(0, 2000) : []) {
      if (typeof p !== 'string' || !p) continue
      try {
        if (statSync(p).isDirectory()) {
          for (const f of readdirSync(p).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) if (isImageFile(f)) out.push(join(p, f))
        } else if (isImageFile(p)) out.push(p)
      } catch {
        // not there
      }
    }
    return out.slice(0, 2000)
  }

  function apply(body, local) {
    switch (body.action) {
      case 'preview': {
        if (!item(body.id)) throw new Error('No such item')
        show.previewId = body.id
        return
      }
      case 'take': {
        takeItem(body.id ?? show.previewId)
        return
      }
      case 'hide': {
        // A graphics page asks to hide what ended (a video set to hide at its end): only if that is still what's on.
        if (body.take !== undefined && show.onAir?.take !== body.take) return
        show.onAir = null
        clearTimeout(hideTimer)
        return
      }
      case 'next': {
        const i = show.items.findIndex((x) => x.id === show.previewId)
        const step = body.back ? -1 : 1
        const n = show.items[Math.min(show.items.length - 1, Math.max(0, i + step))]
        if (n) show.previewId = n.id
        return
      }
      case 'add': {
        const it = addItem(body.item ?? {}, local)
        show.previewId = it.id
        return it.id
      }
      case 'update': {
        const was = item(body.id)
        if (!was) throw new Error('No such item')
        const next = cleanItem(body.item ?? {}, was)
        if (was.kind === 'photos' && body.item?.paths !== undefined) {
          if (!local) throw new Error('Photos are changed on the gfx laptop itself')
          next.paths = photoPaths(body.item.paths)
        }
        if (was.kind === 'video' && body.item?.path !== undefined) {
          if (!local) throw new Error('Videos are changed on the gfx laptop itself')
          if (!isVideoFile(body.item.path)) throw new Error('Pick a video file (mp4, webm, mov)')
          next.path = text(body.item.path, 1000)
        }
        show.items[show.items.indexOf(was)] = next
        return
      }
      case 'remove': {
        const at = show.items.findIndex((i) => i.id === body.id)
        if (at < 0) return
        show.items.splice(at, 1)
        if (show.onAir?.id === body.id) show.onAir = null
        if (show.previewId === body.id) show.previewId = show.items[Math.min(at, show.items.length - 1)]?.id ?? null
        return
      }
      case 'move': {
        const at = show.items.findIndex((i) => i.id === body.id)
        const to = at + (body.up ? -1 : 1)
        if (at < 0 || to < 0 || to >= show.items.length) return
        show.items.splice(to, 0, ...show.items.splice(at, 1))
        return
      }
      case 'look': {
        show.look = cleanLook(body.look ?? {}, show.look)
        return
      }
      default:
        throw new Error('Unknown action')
    }
  }

  const exists = (p) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }

  /** A file from the rundown, with Range support so videos can seek and stream. */
  function sendFile(req, res, path) {
    let size
    try {
      size = statSync(path).size
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return res.end('That file is not on the gfx laptop any more')
    }
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range && size > 0) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2])
      let end = range[1] && range[2] ? Number(range[2]) : size - 1
      start = Math.max(0, start)
      end = Math.min(size - 1, end)
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` })
        return res.end()
      }
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
      return createReadStream(path, { start, end }).pipe(res)
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
    createReadStream(path).pipe(res)
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 2_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'))
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })
  const json = (res, code, value) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const isLocal = (req) => {
    const a = req.socket.remoteAddress ?? ''
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }

  const lanAddresses = () =>
    Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a.address)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    try {
      if (req.method === 'GET' && (path === '/' || path === '/app' || path === '/control')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(readFileSync(join(pagesDir, 'app.html')))
      }
      if (req.method === 'GET' && path === '/live') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(readFileSync(join(pagesDir, 'live.html')))
      }
      if (req.method === 'GET' && path === '/api/info') {
        // Also how the streaming app's "Find gfx apps" and "Test" know this is a gfx app, and which PC.
        return json(res, 200, {
          app: 'gfx-app',
          name: os.hostname(),
          items: show.items.length,
          port: server.address().port,
          addresses: lanAddresses(),
          local: isLocal(req)
        })
      }
      if (req.method === 'GET' && path === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write('retry: 2000\n\n')
        send(res, snapshot())
        listeners.add(res)
        const role = url.searchParams.get('role')
        // The graphics page inside the streaming app says so: the app shows "connected".
        if (role === 'stream') {
          streamPages.add(res)
          broadcast()
        }
        if (role === 'operator') operators.add(res)
        const ping = setInterval(() => res.write(': ping\n\n'), 15000)
        req.on('close', () => {
          clearInterval(ping)
          listeners.delete(res)
          operators.delete(res)
          if (streamPages.delete(res)) {
            if (!streamPages.size) streamLive = false
            broadcast()
          }
        })
        return
      }
      const media = /^\/media\/([\w-]+)(?:\/(\d+))?$/.exec(path)
      if (req.method === 'GET' && media) {
        const it = item(media[1])
        const file = it?.kind === 'video' ? it.path : it?.kind === 'photos' ? it.paths[Number(media[2] ?? 0)] : undefined
        if (!file) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          return res.end('Not in the rundown')
        }
        return sendFile(req, res, file)
      }
      if (req.method === 'POST' && path === '/api/do') {
        const body = await readBody(req)
        const result = apply(body, isLocal(req))
        changed()
        return json(res, 200, { ok: true, result: result ?? null })
      }
      // The graphics page in the streaming app: the stream put it live, or took it off.
      if (req.method === 'POST' && path === '/api/stream') {
        const body = await readBody(req)
        streamLive = body.live === true
        broadcast()
        return json(res, 200, { ok: true })
      }
      // Window capture: a graphics page asks for the window's picture (WebRTC); the operator's window answers.
      if (req.method === 'POST' && path === '/api/rtc/offer') {
        const body = await readBody(req)
        if (!operators.size) return json(res, 503, { error: 'The gfx app window is not open, so it can’t send a window' })
        const id = rtcId++
        const timer = setTimeout(() => {
          pendingRtc.delete(id)
          json(res, 504, { error: 'The gfx app did not answer' })
        }, 15000)
        pendingRtc.set(id, (answer) => {
          clearTimeout(timer)
          json(res, 200, answer)
        })
        const msg = { type: 'rtc-offer', id, itemId: text(body.itemId, 40), sdp: text(body.sdp, 200000) }
        for (const op of operators) send(op, msg)
        return
      }
      if (req.method === 'POST' && path === '/api/rtc/answer') {
        const body = await readBody(req)
        const done = pendingRtc.get(body.id)
        pendingRtc.delete(body.id)
        done?.(body.error ? { error: text(body.error, 300) } : { sdp: text(body.sdp, 200000) })
        return json(res, 200, { ok: true })
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`Not found: ${path}\n\nThis is the gfx app. Its pages are /app (the operator's page) and /live (the graphics, for the streaming app).`)
    } catch (e) {
      json(res, 400, { error: e.message })
    }
  })

  return new Promise((resolve, reject) => {
    const first = opts.port ?? 8765 // 0 = any free port (tests)
    let port = first
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && first && port < first + 20) {
        log(`Port ${port} is used by another program, trying ${port + 1}...`)
        port += 1
        return server.listen(port, '0.0.0.0')
      }
      reject(e)
    })
    server.on('listening', () =>
      resolve({
        port: server.address().port,
        server,
        addresses: lanAddresses,
        close: () => {
          for (const res of listeners) res.end()
          server.close()
        }
      })
    )
    server.listen(port, '0.0.0.0')
  })
}

module.exports = { startServer, cleanLook, cleanItem, DEFAULT_LOOK }

// Run on its own: node gfx-app/server.cjs [--port 8765] [--open]
if (require.main === module) {
  const arg = process.argv.indexOf('--port')
  const port = Number(arg > 0 ? process.argv[arg + 1] : process.env.PORT) || 8765
  startServer({ port })
    .then(({ port: at, addresses }) => {
      console.log('\nThe gfx app is running. Keep this window open.\n')
      console.log(`  Operator page (this PC):  http://localhost:${at}/app`)
      for (const a of addresses()) console.log(`  Add to the streaming app:  http://${a}:${at}/live`)
      if (at !== port) console.log(`\n  Note: port ${port} was taken, so this runs on port ${at}. Use the addresses above.`)
      console.log('')
      if (process.argv.includes('--open')) {
        const target = `http://localhost:${at}/app`
        const cmd = process.platform === 'win32' ? `start "" "${target}"` : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`
        require('node:child_process').exec(cmd, () => {})
      }
    })
    .catch((e) => {
      console.error(`\nThe gfx app could not start: ${e.message}`)
      process.exit(1)
    })
}
