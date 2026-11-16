/**
 * A tiny sample gfx app: a starting point for your own.
 *
 *   node examples/gfx-app/server.cjs            (port 8080)
 *   node examples/gfx-app/server.cjs --port 9000
 *
 * Run it on the graphics laptop. It serves two pages:
 *
 *   /live     the graphics page. Add its address in the streaming app as a
 *             "Graphics (network)" source. Its background is see-through.
 *   /control  the control page. Open it in a browser on the graphics laptop
 *             (or a phone) to type a name, pick a style and show or hide the
 *             lower third.
 *
 * The control page sends changes to this server, and the server passes them
 * to the graphics page right away (Server-Sent Events). The streaming app is
 * not involved: it only shows the graphics page.
 *
 * The look (style, font, sizes, colours...) is saved in gfx-settings.json next
 * to this file, so it is the same next time.
 *
 * No installs needed: plain Node.js, no packages.
 */
const http = require('node:http')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const arg = process.argv.indexOf('--port')
const PORT = Number(arg > 0 ? process.argv[arg + 1] : process.env.PORT) || 8080
const SAVED = join(__dirname, 'gfx-settings.json')

const STYLES = ['classic', 'block', 'minimal', 'news']
const FONTS = ['Inter', 'Space Grotesk', 'Montserrat', 'Roboto Slab', 'custom']
const POSITIONS = ['left', 'center', 'right']
const ANIMATIONS = ['slide', 'fade', 'wipe']

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
  /** Seconds before it hides by itself; 0 = until Hide is pressed. */
  stayFor: 0,
  animation: 'slide'
}

/** What the graphics show now. */
let graphics = { show: false, name: 'Sam Rivera', title: 'Guest speaker', look: { ...DEFAULT_LOOK } }
try {
  const saved = JSON.parse(readFileSync(SAVED, 'utf8'))
  graphics = { ...graphics, name: saved.name ?? graphics.name, title: saved.title ?? graphics.title, look: cleanLook(saved.look ?? {}, DEFAULT_LOOK) }
} catch {
  // first start: the defaults
}

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

/** Graphics pages and control pages listening for changes. */
const listeners = new Set()
let hideTimer = null

const page = (file) => readFileSync(join(__dirname, file))

function broadcast() {
  const msg = `data: ${JSON.stringify(graphics)}\n\n`
  for (const res of listeners) res.write(msg)
}

function save() {
  try {
    writeFileSync(SAVED, JSON.stringify({ name: graphics.name, title: graphics.title, look: graphics.look }, null, 2))
  } catch (e) {
    console.warn('Could not save the settings:', e.message)
  }
}

function change(p) {
  const wasShowing = graphics.show
  graphics = {
    show: typeof p.show === 'boolean' ? p.show : graphics.show,
    name: typeof p.name === 'string' ? p.name.slice(0, 80) : graphics.name,
    title: typeof p.title === 'string' ? p.title.slice(0, 120) : graphics.title,
    look: p.look && typeof p.look === 'object' ? cleanLook(p.look, graphics.look) : graphics.look
  }
  // "Stays on for": hide by itself after that many seconds, counted from Show.
  if (graphics.show && (!wasShowing || p.show === true)) {
    clearTimeout(hideTimer)
    if (graphics.look.stayFor > 0) {
      hideTimer = setTimeout(() => {
        graphics = { ...graphics, show: false }
        broadcast()
      }, graphics.look.stayFor * 1000)
    }
  }
  if (!graphics.show) clearTimeout(hideTimer)
  save()
  broadcast()
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/control')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(page('control.html'))
  }
  if (req.method === 'GET' && url.pathname === '/live') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(page('live.html'))
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(`retry: 2000\ndata: ${JSON.stringify(graphics)}\n\n`)
    listeners.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 15000)
    req.on('close', () => {
      clearInterval(ping)
      listeners.delete(res)
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/graphics') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 10000) req.destroy()
    })
    req.on('end', () => {
      try {
        change(JSON.parse(body))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(graphics))
      } catch {
        res.writeHead(400)
        res.end('Bad request')
      }
    })
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('Not found')
})

server.listen(PORT, '0.0.0.0', () => {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
  console.log('Sample gfx app is running.\n')
  console.log(`  On this PC:  graphics http://localhost:${PORT}/live   control http://localhost:${PORT}/control\n`)
  for (const a of addrs) {
    console.log(`  From another PC on the network:`)
    console.log(`    Add to the streaming app:  http://${a}:${PORT}/live`)
    console.log(`    Control page:              http://${a}:${PORT}/control\n`)
  }
})
