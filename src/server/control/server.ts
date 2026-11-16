/**
 * The control server: one WebSocket on the local network for the tablet
 * remote, the companion app and a future stream deck. It also serves the
 * pages: the main window (only to the streaming PC itself), the tablet
 * remote, the mockup and a developer test page.
 *
 * The main window connects as "local" (full control, settings included).
 * Only a page opened on this PC, from this server's own address, may do that:
 * the connection must come from the PC itself (loopback) and carry this
 * server's own origin, so other websites open in the browser can't.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { CommandError, PROTOCOL_VERSION, ROLES, type Caller, type Role, type ServerMessage } from '../../shared/protocol'
import type { AppState } from '../../shared/state'
import type { Controller } from '../../core/controller'
import { errorText } from '../../core/controller'
import type { PhoneOffer } from '../phones'
import type { PairingManager } from './pairing'
import { TEST_PAGE } from './testPage'

export interface ControlServerOptions {
  controller: Controller
  pairing: PairingManager
  port: number
  /** Address to listen on. 0.0.0.0 = every network the PC is on. */
  host?: string
  /** Folder with the built interface (remote.html and assets/). */
  staticDir?: string
  appVersion?: string
  /** A media connection from the studio page (video and audio for a stream or a recording). */
  onMedia?: (socket: WebSocket, kind: 'stream' | 'record', codec: string) => void
  /** The studio page (the main window that runs the video) came or went. */
  onStudio?: (present: boolean) => void
  /** Phones as cameras: the main window answers each phone that wants to connect. */
  phones?: {
    links(): string[]
    setStudio(send: ((offer: PhoneOffer) => void) | null): void
    answer(reqId: string, r: { sdp?: string; error?: string }): void
  }
  /** Network cameras (a Z CAM on the router): their list, and their video for the main window. */
  netcams?: {
    list(): unknown[]
    set(input: unknown): unknown[]
    attach(socket: WebSocket, id: string): void
  }
  /** Where cameras stream to the app (RTMP); 0 when receiving is off. */
  rtmpPort?: number
}

const MAX_MEDIA_MESSAGE_BYTES = 16 * 1024 * 1024
const PICTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'])

/** True when the request comes from this PC and from a page this server served. */
export function isLocalRequest(req: IncomingMessage, port: number): boolean {
  const addr = req.socket.remoteAddress ?? ''
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  const host = req.headers.host ?? ''
  const okHost = host === `localhost:${port}` || host === `127.0.0.1:${port}`
  const origin = req.headers.origin
  // Browsers always send Origin on WebSocket upgrades; plain page loads may leave it out.
  const okOrigin = origin === undefined ? req.headers.upgrade === undefined : origin === `http://${host}`
  return loopback && okHost && okOrigin
}

interface Client {
  socket: WebSocket
  deviceId: string | null
  name: string
  role: Caller | null
  /** May say hello as the main window: it's on this PC and from this server's page. */
  canBeLocal: boolean
  studio: boolean
  failedPairs: number
  /** Simple rate limit: messages in the current second. */
  windowStart: number
  windowCount: number
}

const AUTH_TIMEOUT_MS = 10_000
const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_MESSAGES_PER_SECOND = 60
const MAX_FAILED_PAIRS = 5

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
}

export class ControlServer {
  private http: Server
  private wss: WebSocketServer
  private media: WebSocketServer
  private clients = new Set<Client>()
  private stateTimer: ReturnType<typeof setTimeout> | null = null
  private boundPort = 0

  constructor(private readonly opts: ControlServerOptions) {
    this.http = createServer((req, res) => {
      this.handleHttp(req, res).catch(() => {
        res.writeHead(500).end()
      })
    })
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
    this.media = new WebSocketServer({ noServer: true, maxPayload: MAX_MEDIA_MESSAGE_BYTES })
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/ws') {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.handleSocket(ws, req))
      } else if (url.pathname === '/media' && this.opts.onMedia && isLocalRequest(req, this.boundPort)) {
        const kind = url.searchParams.get('kind') === 'record' ? 'record' : 'stream'
        const codec = (url.searchParams.get('codec') ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 16)
        this.media.handleUpgrade(req, socket, head, (ws) => this.opts.onMedia!(ws, kind, codec))
      } else if (url.pathname === '/netcam' && this.opts.netcams && isLocalRequest(req, this.boundPort)) {
        const id = (url.searchParams.get('id') ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 40)
        this.media.handleUpgrade(req, socket, head, (ws) => this.opts.netcams!.attach(ws, id))
      } else {
        socket.destroy()
      }
    })

    opts.controller.on('state', () => this.scheduleState())
    opts.controller.on('stats', (stats) => this.broadcast({ type: 'event', name: 'stats', stats }))
    opts.controller.on('error', (message) => this.broadcast({ type: 'event', name: 'notice', message }))
    opts.pairing.onRemove((id) => {
      for (const c of this.clients) if (c.deviceId === id) c.socket.close(4003, 'Removed')
    })
    opts.pairing.onRoleChange((id, role) => {
      for (const c of this.clients) if (c.deviceId === id) c.role = role
    })
  }

  get port() {
    return this.boundPort
  }

  /** Addresses a tablet on the same network can open. */
  urls(): string[] {
    const out: string[] = []
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${this.boundPort}`)
      }
    }
    return out.length ? out : [`http://localhost:${this.boundPort}`]
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => {
        const addr = this.http.address()
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.opts.port
        this.http.off('error', reject)
        resolve()
      })
    })
  }

  async stop() {
    if (this.stateTimer) clearTimeout(this.stateTimer)
    for (const c of this.clients) c.socket.terminate()
    for (const ws of this.media.clients) ws.terminate()
    await new Promise<void>((r) => this.media.close(() => r()))
    await new Promise<void>((r) => this.wss.close(() => r()))
    await new Promise<void>((r) => this.http.close(() => r()))
  }

  // ---------- WebSocket ----------

  private handleSocket(socket: WebSocket, req: IncomingMessage) {
    const client: Client = {
      socket,
      deviceId: null,
      name: '',
      role: null,
      canBeLocal: isLocalRequest(req, this.boundPort),
      studio: false,
      failedPairs: 0,
      windowStart: Date.now(),
      windowCount: 0
    }
    this.clients.add(client)
    const authTimer = setTimeout(() => {
      if (!client.role) socket.close(4001, 'Pair or say hello first')
    }, AUTH_TIMEOUT_MS)

    socket.on('message', (raw, isBinary) => {
      if (isBinary) return this.send(client, { type: 'error', error: 'Send JSON text messages' })
      if (!this.withinRateLimit(client)) return this.send(client, { type: 'error', error: 'Too many messages' })
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return this.send(client, { type: 'error', error: 'Message is not valid JSON' })
      }
      if (!msg || typeof msg !== 'object') return this.send(client, { type: 'error', error: 'Message must be an object' })
      this.handleMessage(client, msg).catch((e) => this.send(client, { type: 'error', error: errorText(e) }))
    })
    socket.on('close', () => {
      clearTimeout(authTimer)
      this.clients.delete(client)
      if (client.deviceId) this.opts.pairing.markConnected(client.deviceId, -1)
      if (client.studio) {
        this.opts.onStudio?.(false)
        this.opts.phones?.setStudio(null)
      }
    })
    socket.on('error', () => socket.terminate())
  }

  private async handleMessage(client: Client, msg: Record<string, unknown>) {
    const { pairing, controller } = this.opts
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 100) : undefined

    if (msg.type === 'pair') {
      const role = (ROLES as unknown[]).includes(msg.role) ? (msg.role as Role) : 'remote'
      try {
        const { device, token } = pairing.pair(String(msg.code ?? ''), String(msg.name ?? ''), role)
        this.send(client, { type: 'paired', v: PROTOCOL_VERSION, deviceId: device.id, token, role: device.role })
        this.authenticate(client, device.id, device.name, device.role)
      } catch (e) {
        client.failedPairs++
        this.send(client, { type: 'error', error: errorText(e) })
        if (client.failedPairs >= MAX_FAILED_PAIRS) client.socket.close(4002, 'Too many wrong codes')
      }
      return
    }

    if (msg.type === 'local') {
      if (!client.canBeLocal) {
        this.send(client, { type: 'error', error: 'Open the main window on the streaming PC itself, at http://localhost:' + this.boundPort })
        client.socket.close(4005, 'Not local')
        return
      }
      client.role = 'local'
      client.name = 'This PC'
      // The first main window to ask runs the video; another tab just shows the controls.
      if (msg.studio === true && ![...this.clients].some((c) => c.studio)) {
        client.studio = true
        this.opts.onStudio?.(true)
        this.opts.phones?.setStudio((offer) => this.send(client, { type: 'phone-offer', ...offer }))
      }
      this.send(client, {
        type: 'welcome',
        v: PROTOCOL_VERSION,
        deviceId: 'local',
        name: client.name,
        role: 'local',
        state: this.opts.controller.state,
        studio: client.studio
      })
      return
    }

    if (msg.type === 'phone-answer') {
      if (!client.studio) return
      this.opts.phones?.answer(String(msg.reqId ?? ''), {
        sdp: typeof msg.sdp === 'string' ? msg.sdp : undefined,
        error: typeof msg.error === 'string' ? msg.error.slice(0, 200) : undefined
      })
      return
    }

    if (msg.type === 'hello') {
      const device = pairing.authenticate(msg.token)
      if (!device) {
        this.send(client, { type: 'error', error: 'Unknown device key. Pair again with the code on the streaming PC.' })
        client.socket.close(4004, 'Unknown key')
        return
      }
      this.authenticate(client, device.id, device.name, device.role)
      return
    }

    if (!client.role) {
      this.send(client, { type: 'error', error: 'Pair or say hello first' })
      return
    }

    if (msg.type === 'command' || msg.type === 'data') {
      const action = msg.type === 'data' ? 'data.set' : msg.action
      const params = msg.type === 'data' ? { values: msg.set } : msg.params
      try {
        const result = await controller.run(client.role, action, params, client.name)
        // Commands that return the whole state don't repeat it: a state event follows.
        const data = result && typeof result === 'object' && 'scenes' in result ? undefined : result
        const state = client.role === 'local' ? controller.state : this.publicState()
        this.send(client, { type: 'result', id, ok: true, data: action === 'state.get' ? state : data })
      } catch (e) {
        const error = e instanceof CommandError ? e.message : `Something went wrong: ${errorText(e)}`
        this.send(client, { type: 'result', id, ok: false, error })
      }
      return
    }

    this.send(client, { type: 'error', error: `Unknown message type: ${String(msg.type)}` })
  }

  private authenticate(client: Client, deviceId: string, name: string, role: Role) {
    client.deviceId = deviceId
    client.name = name
    client.role = role
    this.opts.pairing.markConnected(deviceId, 1)
    this.send(client, {
      type: 'welcome',
      v: PROTOCOL_VERSION,
      deviceId,
      name,
      role,
      state: this.publicState()
    })
  }

  /** State as network devices see it: without the pairing code. */
  private publicState(): AppState {
    const s = this.opts.controller.state
    return { ...s, devices: { ...s.devices, pairingCode: '' } }
  }

  private scheduleState() {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.broadcast({ type: 'event', name: 'state', state: this.publicState() })
    }, 30)
  }

  private broadcast(msg: ServerMessage) {
    const text = JSON.stringify(msg)
    // The main window on this PC also sees the pairing code, to show it.
    const local = msg.type === 'event' && msg.name === 'state' ? JSON.stringify({ ...msg, state: this.opts.controller.state }) : text
    for (const c of this.clients) {
      if (c.role && c.socket.readyState === c.socket.OPEN) c.socket.send(c.role === 'local' ? local : text)
    }
  }

  private send(client: Client, msg: ServerMessage) {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(msg))
  }

  private withinRateLimit(client: Client): boolean {
    const t = Date.now()
    if (t - client.windowStart >= 1000) {
      client.windowStart = t
      client.windowCount = 0
    }
    return ++client.windowCount <= MAX_MESSAGES_PER_SECOND
  }

  // ---------- HTTP ----------

  private async handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    const local = isLocalRequest(req, this.boundPort)
    if (path === '/api/netcams' && (req.method === 'GET' || req.method === 'POST')) {
      // Only the main window on this PC lists or changes the network cameras.
      if (!local || !this.opts.netcams) return void res.writeHead(403).end()
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return void res.writeHead(415).end()
        const body = await readJson(req)
        if (body === undefined) return void res.writeHead(400).end()
        this.opts.netcams.set(body)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // This PC's addresses: a camera that sends to the app needs one of them.
      const ips = this.urls().map((u) => new URL(u).hostname)
      return void res.end(JSON.stringify({ cams: this.opts.netcams.list(), ips, rtmpPort: this.opts.rtmpPort ?? 0 }))
    }
    if (req.method !== 'GET') return void res.writeHead(405).end()

    // The main window is for the streaming PC itself; anyone else gets the tablet remote.
    if (path === '/' && !local) return void res.writeHead(302, { Location: '/remote' }).end()
    if (path === '/files') return this.serveLocalFile(local, url.searchParams.get('path') ?? '', res, req.headers.range)
    if (path === '/api/folder') return this.listPictures(local, url.searchParams.get('path') ?? '', res)
    if (path === '/api/phone-link') {
      // Holds the phone secret: only for the main window on this PC.
      if (!local) return void res.writeHead(403).end()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return void res.end(JSON.stringify({ links: this.opts.phones?.links() ?? [] }))
    }
    if (path === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return void res.end(
        JSON.stringify({ app: 'streaming-app', version: this.opts.appVersion ?? '0.0.0', protocol: PROTOCOL_VERSION, ws: '/ws' })
      )
    }
    if (path === '/test') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      return void res.end(TEST_PAGE)
    }
    const dir = this.opts.staticDir
    if (!dir) return void res.writeHead(404).end('Pages not built. Run npm run build.')
    const file =
      path === '/'
        ? 'index.html'
        : path === '/remote'
          ? 'remote.html'
          : path === '/demo'
            ? 'demo.html'
            : path === '/app.webmanifest' || path === '/remote.webmanifest'
              ? path.slice(1)
              : path.startsWith('/assets/') || path.startsWith('/icons/')
                ? path.slice(1)
                : null
    if (!file) return void res.writeHead(404).end('Not found')
    const full = normalize(join(dir, file))
    if (!full.startsWith(normalize(dir) + sep)) return void res.writeHead(403).end()
    try {
      const body = await readFile(full)
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('Not found')
    }
  }

  /** The pictures in one folder on this PC, in name order, for a slideshow. Only for the main window on this PC. */
  private async listPictures(local: boolean, dir: string, res: ServerResponse) {
    if (!local) return void res.writeHead(403).end()
    try {
      const names = await readdir(dir)
      const files = names
        .filter((n) => PICTURE_EXT.has(extname(n).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .slice(0, 500)
        .map((n) => join(dir, n))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ files }))
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Folder not found' }))
    }
  }

  /** Pictures and video files on this PC, for image and media sources. Only for the main window on this PC. */
  private async serveLocalFile(local: boolean, file: string, res: ServerResponse, range?: string) {
    if (!local) return void res.writeHead(403).end()
    const ext = extname(file).toLowerCase()
    if (!file || !MEDIA_EXT.has(ext)) return void res.writeHead(404).end('Only pictures, video and sound files')
    let size: number
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      size = info.size
    } catch {
      return void res.writeHead(404).end('File not found')
    }
    const type = MIME[ext] ?? 'application/octet-stream'
    // Byte ranges let video and music jump back to the start (and loop) without loading the whole file again.
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
      let end = m[1] && m[2] ? Number(m[2]) : size - 1
      end = Math.min(end, size - 1)
      if (start > end || start >= size) {
        return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      }
      start = Math.max(0, start)
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
      createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
      return
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size })
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }
}

/** A small JSON body (a settings list), or undefined if it is too big or not JSON. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_MESSAGE_BYTES) {
        resolve(undefined)
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}
