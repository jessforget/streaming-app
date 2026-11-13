/**
 * The control server: one WebSocket on the local network for the tablet
 * remote, the companion app and a future stream deck. It also serves the
 * tablet remote page and a developer test page over plain HTTP.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { CommandError, PROTOCOL_VERSION, ROLES, type Role, type ServerMessage } from '../../shared/protocol'
import type { AppState } from '../../shared/state'
import type { Controller } from '../../core/controller'
import { errorText } from '../../core/controller'
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
}

interface Client {
  socket: WebSocket
  deviceId: string | null
  name: string
  role: Role | null
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
  '.json': 'application/json',
  '.woff2': 'font/woff2'
}

export class ControlServer {
  private http: Server
  private wss: WebSocketServer
  private clients = new Set<Client>()
  private stateTimer: ReturnType<typeof setTimeout> | null = null
  private boundPort = 0

  constructor(private readonly opts: ControlServerOptions) {
    this.http = createServer((req, res) => {
      this.handleHttp(req, res).catch(() => {
        res.writeHead(500).end()
      })
    })
    this.wss = new WebSocketServer({ server: this.http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES })
    this.wss.on('connection', (socket) => this.handleSocket(socket))

    opts.controller.on('state', () => this.scheduleState())
    opts.controller.on('stats', (stats) => this.broadcast({ type: 'event', name: 'stats', stats }))
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
    await new Promise<void>((r) => this.wss.close(() => r()))
    await new Promise<void>((r) => this.http.close(() => r()))
  }

  // ---------- WebSocket ----------

  private handleSocket(socket: WebSocket) {
    const client: Client = {
      socket,
      deviceId: null,
      name: '',
      role: null,
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
        this.send(client, { type: 'result', id, ok: true, data: action === 'state.get' ? this.publicState() : data })
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
    for (const c of this.clients) if (c.role && c.socket.readyState === c.socket.OPEN) c.socket.send(text)
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
    if (req.method !== 'GET') return void res.writeHead(405).end()

    if (path === '/') return void res.writeHead(302, { Location: '/remote' }).end()
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
    if (!dir) return void res.writeHead(404).end('Remote page not built. Run npm run build.')
    const file = path === '/remote' ? 'remote.html' : path.startsWith('/assets/') ? path.slice(1) : null
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
}
