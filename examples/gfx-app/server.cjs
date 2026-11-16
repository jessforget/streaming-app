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
 *             (or a phone) to type a name and show or hide the lower third.
 *
 * The control page sends changes to this server, and the server passes them
 * to the graphics page right away (Server-Sent Events). The streaming app is
 * not involved: it only shows the graphics page.
 *
 * No installs needed: plain Node.js, no packages.
 */
const http = require('node:http')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const arg = process.argv.indexOf('--port')
const PORT = Number(arg > 0 ? process.argv[arg + 1] : process.env.PORT) || 8080

/** What the graphics show now. */
let graphics = { show: false, name: 'Sam Rivera', title: 'Guest speaker' }
/** Graphics pages listening for changes. */
const listeners = new Set()

const page = (file) => readFileSync(join(__dirname, file))

function broadcast() {
  const msg = `data: ${JSON.stringify(graphics)}\n\n`
  for (const res of listeners) res.write(msg)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/control')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
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
        const p = JSON.parse(body)
        graphics = {
          show: typeof p.show === 'boolean' ? p.show : graphics.show,
          name: typeof p.name === 'string' ? p.name.slice(0, 80) : graphics.name,
          title: typeof p.title === 'string' ? p.title.slice(0, 120) : graphics.title
        }
        broadcast()
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
  for (const a of addrs.length ? addrs : ['localhost']) {
    console.log(`  Add to the streaming app:  http://${a}:${PORT}/live`)
    console.log(`  Control page:              http://${a}:${PORT}/control\n`)
  }
})
