/**
 * Phones as cameras. A phone on the same network scans the QR code in the
 * app, opens a camera page in its browser (no app to install, Android or
 * iPhone) and sends its camera and microphone straight to the main window
 * with WebRTC. The phone then shows up in the device list like a webcam.
 *
 * Phones only let a page use the camera over HTTPS, so this part of the app
 * has its own HTTPS address (port 7421) with a certificate made on this PC.
 * The phone warns about that certificate once; that is expected.
 *
 * The phone page talks to the app with plain HTTPS requests (no WebSocket),
 * because iPhones refuse WebSockets to a certificate made on this PC. Only
 * the start of each connection goes through the app; the video itself goes
 * from the phone to the main window directly.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { PHONE_PAGE } from './phonePage'

export const DEFAULT_PHONE_PORT = 7421
const OFFER_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 64 * 1024

export interface PhoneOffer {
  /** Empty when the phone says goodbye (Stop pressed, or the page closed). */
  reqId: string
  /** The phone's own id, kept on the phone, so it is the same device after a reconnect. */
  id: string
  name: string
  sdp: string
}

export interface PhoneHubOptions {
  dataDir: string
  /** The built interface, for the app icons. */
  staticDir?: string
  port?: number
  log?: (line: string) => void
}

interface CertFile {
  ips: string[]
  cert: string
  key: string
}

/** This PC's addresses on the network, the ones a phone can reach. */
export function lanAddresses(): string[] {
  return namedLanAddresses().map((a) => a.ip)
}

/** Adapters made by other programs (WSL, VirtualBox, VMware, Docker): other computers can't reach these. */
const VIRTUAL = /vethernet|virtual|vmware|vbox|docker|hyper-v|wsl|loopback|tailscale|zerotier|vpn/i

/** This PC's addresses with their adapter's name ("Wi-Fi", "Ethernet"); real adapters first. */
export function namedLanAddresses(): { name: string; ip: string }[] {
  const out: { name: string; ip: string }[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address })
  }
  return out.sort((a, b) => Number(VIRTUAL.test(a.name)) - Number(VIRTUAL.test(b.name)))
}

/** A certificate for this PC's addresses, made once and kept (made again if the address changes). */
export async function loadOrMakeCert(dir: string, ips: string[]): Promise<{ cert: string; key: string }> {
  const file = join(dir, 'phone-cert.json')
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as CertFile
    if (saved.cert && saved.key && ips.every((ip) => saved.ips.includes(ip))) return saved
  } catch {
    // none yet
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const selfsigned = require('selfsigned') as typeof import('selfsigned')
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))]
  const made = await selfsigned.generate([{ name: 'commonName', value: 'Streaming App (this PC)' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  } as never)
  const out: CertFile = { ips, cert: made.cert, key: made.private }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(out), { mode: 0o600 })
  } catch {
    // works for this run anyway; the phone will warn again next time
  }
  return out
}

/** The secret in the QR code. Kept, so phones that joined once can reconnect after the app restarts. */
function loadOrMakeToken(dir: string): string {
  const file = join(dir, 'phone-token')
  try {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[a-f0-9]{32}$/.test(t)) return t
  } catch {
    // none yet
  }
  const t = randomBytes(16).toString('hex')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, t, { mode: 0o600 })
  } catch {
    // works for this run anyway
  }
  return t
}

export class PhoneHub {
  readonly token: string
  readonly port: number
  private https: Server | null = null
  private toStudio: ((offer: PhoneOffer) => void) | null = null
  private waiting = new Map<string, (r: { sdp?: string; error?: string }) => void>()
  private nextReq = 1

  constructor(private readonly opts: PhoneHubOptions) {
    this.token = loadOrMakeToken(opts.dataDir)
    this.port = opts.port ?? DEFAULT_PHONE_PORT
  }

  async start() {
    const { cert, key } = await loadOrMakeCert(this.opts.dataDir, lanAddresses())
    this.https = createServer({ cert, key }, (req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.https!.once('error', reject)
      this.https!.listen(this.port, () => {
        this.https!.off('error', reject)
        resolve()
      })
    })
  }

  /** What the QR code holds. The secret is after #, so it never travels in a request line. */
  links(): string[] {
    const ips = lanAddresses()
    return (ips.length ? ips : ['localhost']).map((ip) => `https://${ip}:${this.port}/cam#${this.token}`)
  }

  /** The main window that runs the video came (with a way to reach it) or went. */
  setStudio(send: ((offer: PhoneOffer) => void) | null) {
    this.toStudio = send
  }

  /** The main window's answer to a phone. */
  answer(reqId: string, r: { sdp?: string; error?: string }) {
    const done = this.waiting.get(reqId)
    if (done) {
      this.waiting.delete(reqId)
      done(r)
    }
  }

  async stop() {
    for (const done of this.waiting.values()) done({ error: 'The app is closing' })
    this.waiting.clear()
    if (this.https) await new Promise<void>((r) => this.https!.close(() => r()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'https://localhost')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/cam')) {
      if (url.pathname === '/') return void res.writeHead(302, { Location: '/cam' }).end()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' })
      return void res.end(PHONE_PAGE)
    }
    // "Add to Home Screen": the camera page opens like an app, with no address bar.
    if (req.method === 'GET' && url.pathname === '/cam.webmanifest') {
      const start = url.searchParams.get('t') === this.token ? `/cam#${this.token}` : '/cam'
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' })
      return void res.end(
        JSON.stringify({
          id: '/cam',
          name: 'Phone camera',
          short_name: 'Camera',
          start_url: start,
          scope: '/cam',
          display: 'fullscreen',
          orientation: 'any',
          background_color: '#0e1014',
          theme_color: '#0e1014',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
          ]
        })
      )
    }
    const icon = /^\/icons\/([a-z0-9-]+\.png)$/.exec(url.pathname)
    if (req.method === 'GET' && icon && this.opts.staticDir) {
      try {
        const body = readFileSync(join(this.opts.staticDir, 'icons', icon[1]))
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return void res.end(body)
      } catch {
        return void res.writeHead(404).end()
      }
    }
    if (req.method === 'POST' && url.pathname === '/cam/bye') {
      const body = await readBody(req)
      let msg: { t?: unknown; id?: unknown } = {}
      try {
        msg = JSON.parse(body ?? '')
      } catch {
        // ignore
      }
      const id = typeof msg.id === 'string' ? msg.id.replace(/[^a-z0-9]/gi, '').slice(0, 32) : ''
      if (msg.t === this.token && id) this.toStudio?.({ reqId: '', id, name: '', sdp: '' })
      return json(res, 200, {})
    }
    if (req.method === 'POST' && url.pathname === '/cam/offer') {
      const body = await readBody(req)
      if (body === null) return json(res, 413, { error: 'Too big' })
      let msg: { t?: unknown; id?: unknown; name?: unknown; sdp?: unknown }
      try {
        msg = JSON.parse(body)
      } catch {
        return json(res, 400, { error: 'Not JSON' })
      }
      if (msg.t !== this.token) return json(res, 403, { error: 'This QR code is old. Scan the one in the app again.' })
      const id = typeof msg.id === 'string' ? msg.id.replace(/[^a-z0-9]/gi, '').slice(0, 32) : ''
      const name = typeof msg.name === 'string' ? msg.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) : ''
      if (!id || typeof msg.sdp !== 'string' || msg.sdp.length > MAX_BODY_BYTES) return json(res, 400, { error: 'Bad request' })
      const send = this.toStudio
      if (!send) return json(res, 503, { error: 'Open the app’s main window on the PC first.' })
      const reqId = String(this.nextReq++)
      const answer = await new Promise<{ sdp?: string; error?: string }>((resolve) => {
        this.waiting.set(reqId, resolve)
        setTimeout(() => this.answer(reqId, { error: 'The app did not answer. Is its main window open?' }), OFFER_TIMEOUT_MS)
        send({ reqId, id, name: name || 'Phone', sdp: msg.sdp as string })
      })
      if (answer.sdp) this.opts.log?.(`phone camera "${name || 'Phone'}" connecting`)
      return answer.sdp ? json(res, 200, { sdp: answer.sdp }) : json(res, 503, { error: answer.error ?? 'No answer' })
    }
    res.writeHead(404).end('Not found')
  }
}

function json(res: ServerResponse, code: number, body: object) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}
