/**
 * A small RTMP receiver, so any camera that can "live stream" (GoPro, Sony,
 * DJI, Insta360, a phone app, OBS on another PC) can send its picture to the
 * app, with nothing to set up per camera. Every camera uses the same address:
 *
 *   Server URL  rtmp://<this PC>:1935/live
 *   Stream key  any name, like the camera's ("gopro", "fx3")
 *
 * Each stream that arrives is listed by its stream key and shows up in the
 * app as a source by itself. Only the H.264 video is used (that's what
 * cameras send); sound and other codecs are ignored.
 *
 * This speaks just enough RTMP for publishing: the simple handshake,
 * chunking, connect / createStream / publish, and the video messages.
 */
import { createServer, type Server, type Socket } from 'node:net'

export const DEFAULT_RTMP_PORT = 1935
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024
const MAX_STREAMS = 16

export interface RtmpPicture {
  /** H.264 picture in Annex B form (start codes); key pictures start with the SPS and PPS. */
  data: Buffer
  key: boolean
}

export interface RtmpStream {
  /** The stream key as the camera sent it. */
  name: string
  /** Safe id made from the name, for the device list: "rtmp-gopro". */
  id: string
  /** "avc1.640028", once the camera sent its settings. Empty for a codec the app can't show. */
  codec: string
  /** Why the picture can't be shown, when it can't (an H.265 camera). */
  problem: string
  from: string
  since: number
}

/** "GoPro Hero 12!" -> "rtmp-gopro-hero-12" */
export function rtmpId(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return `rtmp-${s || 'camera'}`
}

// ---------- AMF0 (the command format) ----------

type Amf = number | boolean | string | null | undefined | Amf[] | { [k: string]: Amf }

export function amfDecode(buf: Buffer): Amf[] {
  const out: Amf[] = []
  let i = 0
  const str = (long = false): string => {
    const n = long ? buf.readUInt32BE(i) : buf.readUInt16BE(i)
    i += long ? 4 : 2
    const s = buf.toString('utf8', i, i + n)
    i += n
    return s
  }
  const props = (): { [k: string]: Amf } => {
    const o: { [k: string]: Amf } = {}
    while (i + 3 <= buf.length) {
      if (buf.readUInt16BE(i) === 0 && buf[i + 2] === 9) {
        i += 3
        break
      }
      const k = str()
      o[k] = value()
    }
    return o
  }
  const value = (): Amf => {
    const t = buf[i++]
    switch (t) {
      case 0: {
        const n = buf.readDoubleBE(i)
        i += 8
        return n
      }
      case 1:
        return buf[i++] !== 0
      case 2:
        return str()
      case 3:
        return props()
      case 5:
        return null
      case 6:
        return undefined
      case 8:
        i += 4
        return props()
      case 10: {
        const n = buf.readUInt32BE(i)
        i += 4
        const a: Amf[] = []
        for (let k = 0; k < n; k++) a.push(value())
        return a
      }
      case 11:
        i += 10
        return null
      case 12:
        return str(true)
      default:
        throw new Error(`AMF type ${t}`)
    }
  }
  try {
    while (i < buf.length) out.push(value())
  } catch {
    // keep what was read
  }
  return out
}

export function amfEncode(...values: Amf[]): Buffer {
  const parts: Buffer[] = []
  const str = (s: string) => {
    const b = Buffer.from(s, 'utf8')
    const h = Buffer.alloc(2)
    h.writeUInt16BE(b.length)
    parts.push(h, b)
  }
  const value = (v: Amf) => {
    if (typeof v === 'number') {
      const b = Buffer.alloc(9)
      b[0] = 0
      b.writeDoubleBE(v, 1)
      parts.push(b)
    } else if (typeof v === 'boolean') parts.push(Buffer.from([1, v ? 1 : 0]))
    else if (typeof v === 'string') {
      parts.push(Buffer.from([2]))
      str(v)
    } else if (v === null) parts.push(Buffer.from([5]))
    else if (v === undefined) parts.push(Buffer.from([6]))
    else if (Array.isArray(v)) throw new Error('not needed')
    else {
      parts.push(Buffer.from([3]))
      for (const [k, x] of Object.entries(v)) {
        str(k)
        value(x)
      }
      parts.push(Buffer.from([0, 0, 9]))
    }
  }
  values.forEach(value)
  return Buffer.concat(parts)
}

// ---------- H.264 in FLV ----------

interface AvcConfig {
  codec: string
  lengthSize: number
  /** SPS and PPS, Annex B. */
  params: Buffer
}

const START = Buffer.from([0, 0, 0, 1])

/** The camera's H.264 settings (AVCDecoderConfigurationRecord). */
export function parseAvcConfig(b: Buffer): AvcConfig | null {
  if (b.length < 7 || b[0] !== 1) return null
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  const codec = `avc1.${hex(b[1])}${hex(b[2])}${hex(b[3])}`
  const lengthSize = (b[4] & 3) + 1
  const parts: Buffer[] = []
  let i = 5
  const nSps = b[i++] & 0x1f
  for (let k = 0; k < nSps && i + 2 <= b.length; k++) {
    const n = b.readUInt16BE(i)
    parts.push(START, b.subarray(i + 2, i + 2 + n))
    i += 2 + n
  }
  const nPps = i < b.length ? b[i++] : 0
  for (let k = 0; k < nPps && i + 2 <= b.length; k++) {
    const n = b.readUInt16BE(i)
    parts.push(START, b.subarray(i + 2, i + 2 + n))
    i += 2 + n
  }
  return { codec, lengthSize, params: Buffer.concat(parts) }
}

/** Length-prefixed NAL units (as in FLV and MP4) to Annex B. */
export function toAnnexB(b: Buffer, lengthSize: number): Buffer {
  const parts: Buffer[] = []
  let i = 0
  while (i + lengthSize <= b.length) {
    let n = 0
    for (let k = 0; k < lengthSize; k++) n = n * 256 + b[i + k]
    i += lengthSize
    if (n <= 0 || i + n > b.length) break
    parts.push(START, b.subarray(i, i + n))
    i += n
  }
  return Buffer.concat(parts)
}

// ---------- the receiver ----------

interface ChunkState {
  ts: number
  delta: number
  length: number
  type: number
  streamId: number
  extended: boolean
  body: Buffer[]
  got: number
}

type Listener = (pic: RtmpPicture) => void

interface Live {
  info: RtmpStream
  config: AvcConfig | null
  listeners: Set<Listener>
  conn: Connection
}

export class RtmpReceiver {
  private server: Server | null = null
  private streams = new Map<string, Live>()
  private changeFns = new Set<() => void>()
  readonly port: number

  constructor(opts: { port?: number; host?: string; log?: (line: string) => void } = {}) {
    this.port = opts.port ?? DEFAULT_RTMP_PORT
    this.host = opts.host ?? '0.0.0.0'
    this.log = opts.log ?? (() => {})
  }
  private readonly host: string
  readonly log: (line: string) => void

  start(): Promise<void> {
    this.server = createServer((socket) => new Connection(socket, this))
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
  }

  async stop() {
    for (const s of this.streams.values()) s.conn.close()
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()))
  }

  /** Cameras streaming to the app right now. */
  list(): RtmpStream[] {
    return [...this.streams.values()].map((s) => s.info)
  }

  onChange(fn: () => void) {
    this.changeFns.add(fn)
    return () => this.changeFns.delete(fn)
  }

  /** Get each picture of one stream (from its next key picture). Call the returned function to stop. */
  subscribe(id: string, fn: Listener, onCodec: (codec: string) => void): (() => void) | null {
    const s = this.streams.get(id)
    if (!s) return null
    s.listeners.add(fn)
    if (s.config) onCodec(s.config.codec)
    return () => s.listeners.delete(fn)
  }

  // ----- called by connections -----

  /** A camera started publishing. A camera that comes back with the same key takes over its old place. */
  publish(conn: Connection, name: string, from: string): string | null {
    const id = rtmpId(name)
    const old = this.streams.get(id)
    if (old && old.conn !== conn) old.conn.close()
    else if (this.streams.size >= MAX_STREAMS) return null
    this.streams.set(id, { info: { name, id, codec: '', problem: '', from, since: Date.now() }, config: null, listeners: new Set(), conn })
    this.log(`camera "${name}" started streaming to the app (from ${from})`)
    this.changed()
    return id
  }

  unpublish(conn: Connection, id: string) {
    const s = this.streams.get(id)
    if (!s || s.conn !== conn) return
    this.streams.delete(id)
    this.log(`camera "${s.info.name}" stopped streaming to the app`)
    this.changed()
  }

  video(conn: Connection, id: string, msg: Buffer) {
    const s = this.streams.get(id)
    if (!s || s.conn !== conn || msg.length < 2) return
    const frameType = (msg[0] >> 4) & 0x7
    // Enhanced RTMP (a FourCC codec, like H.265 "hvc1"): not something the decoder here takes.
    if (msg[0] & 0x80) {
      const fourcc = msg.length >= 5 ? msg.toString('latin1', 1, 5) : ''
      if (!s.info.problem) {
        s.info.problem = `The camera sends ${fourcc === 'hvc1' ? 'H.265' : fourcc || 'a new codec'}. Set it to H.264.`
        this.changed()
      }
      return
    }
    if ((msg[0] & 0x0f) !== 7 || msg.length < 5) {
      if (!s.info.problem) {
        s.info.problem = 'The camera sends a video format the app does not read. Set it to H.264.'
        this.changed()
      }
      return
    }
    const packetType = msg[1]
    const body = msg.subarray(5)
    if (packetType === 0) {
      const config = parseAvcConfig(body)
      if (!config) return
      s.config = config
      if (s.info.codec !== config.codec) {
        s.info.codec = config.codec
        s.info.problem = ''
        this.changed()
      }
      return
    }
    if (packetType !== 1 || !s.config || !s.listeners.size) return
    const key = frameType === 1
    const nals = toAnnexB(body, s.config.lengthSize)
    if (!nals.length) return
    const data = key ? Buffer.concat([s.config.params, nals]) : nals
    for (const fn of s.listeners) fn({ data, key })
  }

  private changed() {
    this.changeFns.forEach((fn) => fn())
  }
}

class Connection {
  private buf: Buffer = Buffer.alloc(0)
  private stage: 'c0c1' | 'c2' | 'chunks' = 'c0c1'
  private inChunkSize = 128
  private outChunkSize = 4096
  private chunks = new Map<number, ChunkState>()
  private received = 0
  private ackWindow = 2_500_000
  private lastAck = 0
  private streamId = ''
  private readonly from: string
  private closed = false

  constructor(
    private readonly socket: Socket,
    private readonly hub: RtmpReceiver
  ) {
    this.from = (socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    socket.setNoDelay(true)
    socket.setTimeout(30_000, () => this.close())
    socket.on('data', (d: Buffer) => {
      try {
        this.onData(d)
      } catch (e) {
        hub.log(`! RTMP from ${this.from}: ${String(e)}`)
        this.close()
      }
    })
    socket.on('close', () => this.ended())
    socket.on('error', () => this.close())
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    this.ended()
  }

  private ended() {
    this.closed = true
    if (this.streamId) this.hub.unpublish(this, this.streamId)
    this.streamId = ''
  }

  private onData(d: Buffer) {
    this.received += d.length
    if (this.received - this.lastAck >= this.ackWindow) {
      this.lastAck = this.received
      const b = Buffer.alloc(4)
      b.writeUInt32BE(this.received >>> 0)
      this.send(2, 3, 0, b)
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d
    if (this.stage === 'c0c1') {
      if (this.buf.length < 1537) return
      if (this.buf[0] !== 3) throw new Error('not RTMP')
      const c1 = this.buf.subarray(1, 1537)
      // The simple handshake: S0, S1 (our own), S2 (their C1 back).
      const s1 = Buffer.alloc(1536)
      s1.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0)
      for (let i = 8; i < 1536; i++) s1[i] = (Math.random() * 256) | 0
      this.socket.write(Buffer.concat([Buffer.from([3]), s1, c1]))
      this.buf = this.buf.subarray(1537)
      this.stage = 'c2'
    }
    if (this.stage === 'c2') {
      if (this.buf.length < 1536) return
      this.buf = this.buf.subarray(1536)
      this.stage = 'chunks'
    }
    this.readChunks()
  }

  private readChunks() {
    const b = this.buf
    let i = 0
    for (;;) {
      if (i >= b.length) break
      const start = i
      const fmt = b[i] >> 6
      let csid = b[i] & 0x3f
      i++
      if (csid === 0) {
        if (i + 1 > b.length) return this.keep(start)
        csid = 64 + b[i]
        i += 1
      } else if (csid === 1) {
        if (i + 2 > b.length) return this.keep(start)
        csid = 64 + b[i] + b[i + 1] * 256
        i += 2
      }
      const headerLen = [11, 7, 3, 0][fmt]
      if (i + headerLen > b.length) return this.keep(start)
      let st = this.chunks.get(csid)
      if (!st) {
        if (fmt !== 0) throw new Error('chunk stream without a first header')
        st = { ts: 0, delta: 0, length: 0, type: 0, streamId: 0, extended: false, body: [], got: 0 }
        this.chunks.set(csid, st)
      }
      let tsField = -1
      if (fmt <= 2) tsField = b.readUIntBE(i, 3)
      if (fmt <= 1) {
        st.length = b.readUIntBE(i + 3, 3)
        st.type = b[i + 6]
        if (st.length > MAX_MESSAGE_BYTES) throw new Error('message too big')
      }
      if (fmt === 0) st.streamId = b.readUInt32LE(i + 7)
      i += headerLen
      if (fmt <= 2) st.extended = tsField === 0xffffff
      if (st.extended) {
        if (i + 4 > b.length) return this.keep(start)
        if (fmt <= 2) tsField = b.readUInt32BE(i)
        i += 4
      }
      const take = Math.min(this.inChunkSize, st.length - st.got)
      if (i + take > b.length) return this.keep(start)
      // Timestamps only matter for order here; keep them roughly right.
      if (st.got === 0 && tsField >= 0) {
        if (fmt === 0) st.ts = tsField
        else st.delta = tsField
      }
      st.body.push(b.subarray(i, i + take))
      st.got += take
      i += take
      if (st.got >= st.length) {
        if (fmt !== 0) st.ts += st.delta
        const msg = Buffer.concat(st.body)
        st.body = []
        st.got = 0
        this.onMessage(st.type, st.streamId, msg)
        if (this.closed) return
      }
    }
    this.buf = Buffer.alloc(0)
  }

  private keep(from: number) {
    this.buf = Buffer.from(this.buf.subarray(from))
  }

  private onMessage(type: number, streamId: number, msg: Buffer) {
    switch (type) {
      case 1:
        this.inChunkSize = Math.max(1, msg.readUInt32BE(0) & 0x7fffffff)
        return
      case 5:
        this.ackWindow = Math.max(4096, msg.readUInt32BE(0))
        return
      case 4:
        // Ping request: answer it.
        if (msg.readUInt16BE(0) === 6) {
          const r = Buffer.alloc(6)
          r.writeUInt16BE(7, 0)
          msg.copy(r, 2, 2, 6)
          this.send(2, 4, 0, r)
        }
        return
      case 20:
        return this.onCommand(streamId, amfDecode(msg))
      case 17:
        return this.onCommand(streamId, amfDecode(msg.subarray(1)))
      case 9:
        if (this.streamId) this.hub.video(this, this.streamId, msg)
        return
      default:
        // audio (8), metadata (18) and the rest: not needed
        return
    }
  }

  private onCommand(streamId: number, args: Amf[]) {
    const [name, txn] = args
    const t = typeof txn === 'number' ? txn : 0
    switch (name) {
      case 'connect': {
        const w = Buffer.alloc(4)
        w.writeUInt32BE(2_500_000)
        this.send(2, 5, 0, w)
        const bw = Buffer.alloc(5)
        bw.writeUInt32BE(2_500_000)
        bw[4] = 2
        this.send(2, 6, 0, bw)
        const cs = Buffer.alloc(4)
        cs.writeUInt32BE(this.outChunkSize)
        this.send(2, 1, 0, cs)
        this.send(
          3,
          20,
          0,
          amfEncode(
            '_result',
            t,
            { fmsVer: 'FMS/3,0,1,123', capabilities: 31 },
            { level: 'status', code: 'NetConnection.Connect.Success', description: 'Connection succeeded.', objectEncoding: 0 }
          )
        )
        return
      }
      case 'createStream':
        this.send(3, 20, 0, amfEncode('_result', t, null, 1))
        return
      case 'releaseStream':
      case 'FCPublish':
      case '_checkbw':
        if (t) this.send(3, 20, 0, amfEncode('_result', t, null, undefined))
        return
      case 'publish': {
        const key = typeof args[3] === 'string' ? args[3].split('?')[0] : ''
        const id = this.hub.publish(this, key || 'camera', this.from)
        const sid = streamId || 1
        if (!id) {
          this.send(5, 20, sid, amfEncode('onStatus', 0, null, { level: 'error', code: 'NetStream.Publish.BadName', description: 'Too many cameras.' }))
          return this.close()
        }
        this.streamId = id
        this.send(5, 20, sid, amfEncode('onStatus', 0, null, { level: 'status', code: 'NetStream.Publish.Start', description: `${key} is now published.` }))
        return
      }
      case 'FCUnpublish':
      case 'deleteStream':
      case 'closeStream':
        if (this.streamId) this.hub.unpublish(this, this.streamId)
        this.streamId = ''
        return
      default:
        return
    }
  }

  /** One message, cut into chunks. */
  private send(csid: number, type: number, streamId: number, body: Buffer) {
    if (this.closed) return
    const parts: Buffer[] = []
    const h = Buffer.alloc(12)
    h[0] = csid & 0x3f
    h.writeUIntBE(0, 1, 3)
    h.writeUIntBE(body.length, 4, 3)
    h[7] = type
    h.writeUInt32LE(streamId, 8)
    parts.push(h)
    for (let i = 0; i < body.length; i += this.outChunkSize) {
      if (i > 0) parts.push(Buffer.from([0xc0 | (csid & 0x3f)]))
      parts.push(body.subarray(i, i + this.outChunkSize))
    }
    this.socket.write(Buffer.concat(parts))
  }
}

// ---------- checking a stream key ----------

/** Reads RTMP chunks into whole messages (for the key check). */
function chunkReader(onMessage: (type: number, msg: Buffer) => void) {
  let buf: Buffer = Buffer.alloc(0)
  let size = 128
  const states = new Map<number, { length: number; type: number; extended: boolean; body: Buffer[]; got: number }>()
  return (d: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d
    let i = 0
    for (;;) {
      if (i >= buf.length) break
      const start = i
      const fmt = buf[i] >> 6
      let csid = buf[i] & 0x3f
      i++
      if (csid === 0) {
        if (i + 1 > buf.length) break
        csid = 64 + buf[i++]
      } else if (csid === 1) {
        if (i + 2 > buf.length) break
        csid = 64 + buf[i] + buf[i + 1] * 256
        i += 2
      }
      const headerLen = [11, 7, 3, 0][fmt]
      if (i + headerLen > buf.length) {
        i = start
        break
      }
      let st = states.get(csid)
      if (!st) {
        st = { length: 0, type: 0, extended: false, body: [], got: 0 }
        states.set(csid, st)
      }
      const tsField = fmt <= 2 ? buf.readUIntBE(i, 3) : -1
      if (fmt <= 1) {
        st.length = buf.readUIntBE(i + 3, 3)
        st.type = buf[i + 6]
      }
      i += headerLen
      if (fmt <= 2) st.extended = tsField === 0xffffff
      if (st.extended) i += 4
      const take = Math.min(size, st.length - st.got)
      if (i + take > buf.length) {
        i = start
        break
      }
      st.body.push(buf.subarray(i, i + take))
      st.got += take
      i += take
      if (st.got >= st.length) {
        const msg = Buffer.concat(st.body)
        st.body = []
        st.got = 0
        if (st.type === 1 && msg.length >= 4) size = Math.max(1, msg.readUInt32BE(0) & 0x7fffffff)
        onMessage(st.type, msg)
      }
    }
    buf = Buffer.from(buf.subarray(i))
  }
}

function chunked(csid: number, type: number, streamId: number, body: Buffer, size: number): Buffer {
  const h = Buffer.alloc(12)
  h[0] = csid
  h.writeUIntBE(body.length, 4, 3)
  h[7] = type
  h.writeUInt32LE(streamId, 8)
  const parts: Buffer[] = [h]
  for (let i = 0; i < body.length; i += size) {
    if (i > 0) parts.push(Buffer.from([0xc0 | csid]))
    parts.push(body.subarray(i, i + size))
  }
  return Buffer.concat(parts)
}

export interface KeyCheck {
  ok: boolean
  /** Plain words for the person. */
  message: string
}

/**
 * Check a stream key without going live: connect to the platform as a stream
 * would and ask to publish with this key, then hang up before any video is
 * sent. A platform that knows the key answers "Publish.Start"; one that doesn't
 * hangs up or says no.
 */
export function checkStreamKey(serverUrl: string, key: string, timeoutMs = 12_000): Promise<KeyCheck> {
  return new Promise((resolve) => {
    let u: URL
    try {
      u = new URL(serverUrl)
    } catch {
      return resolve({ ok: false, message: 'The server address is not valid.' })
    }
    const secure = u.protocol === 'rtmps:'
    if (!secure && u.protocol !== 'rtmp:') return resolve({ ok: false, message: 'The server address must start with rtmp:// or rtmps://' })
    const host = u.hostname
    const port = Number(u.port) || (secure ? 443 : 1935)
    const app = u.pathname.replace(/^\/+|\/+$/g, '') + (u.search ?? '')
    const tcUrl = serverUrl.replace(/\/+$/, '')
    const OUT = 4096
    let stage: 'hs' | 'chunks' = 'hs'
    let hs: Buffer = Buffer.alloc(0)
    let settled = false
    let streamId = 0
    let askedPublish = false
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sock: Socket = secure ? require('node:tls').connect({ host, port, servername: host }) : require('node:net').connect({ host, port })
    const done = (r: KeyCheck) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (streamId) {
          sock.write(chunked(3, 20, 0, amfEncode('FCUnpublish', 6, null, key), OUT))
          sock.write(chunked(3, 20, 0, amfEncode('deleteStream', 7, null, streamId), OUT))
        }
      } catch {
        // closing anyway
      }
      sock.destroy()
      resolve(r)
    }
    const timer = setTimeout(
      () => done({ ok: false, message: askedPublish ? 'The platform did not answer about the key. Check the key and try again.' : 'Could not reach the platform. Check the internet connection.' }),
      timeoutMs
    )
    const read = chunkReader((type, msg) => {
      if (type !== 20) return
      const [name, txn, , info] = amfDecode(msg)
      const code = info && typeof info === 'object' && !Array.isArray(info) ? String((info as Record<string, Amf>).code ?? '') : ''
      if (name === '_result' && txn === 1) {
        // Connected: ask for a stream, then to publish with the key.
        sock.write(
          Buffer.concat([
            chunked(3, 20, 0, amfEncode('releaseStream', 2, null, key), OUT),
            chunked(3, 20, 0, amfEncode('FCPublish', 3, null, key), OUT),
            chunked(3, 20, 0, amfEncode('createStream', 4, null), OUT)
          ])
        )
      } else if (name === '_result' && txn === 4) {
        streamId = typeof info === 'number' ? info : 1
        askedPublish = true
        sock.write(chunked(4, 20, streamId, amfEncode('publish', 5, null, key, 'live'), OUT))
      } else if (name === '_error' && txn === 1) {
        done({ ok: false, message: 'The platform refused the connection. Check the server address.' })
      } else if (name === 'onStatus') {
        if (code === 'NetStream.Publish.Start') done({ ok: true, message: 'The platform accepted this key.' })
        else if (/Publish\.(BadName|Rejected|Denied)|Failed|Error/i.test(code)) done({ ok: false, message: 'The platform did not accept this key. Copy it again from the platform and save it.' })
      }
    })
    const start = () => {
      const c1 = Buffer.alloc(1536)
      for (let i = 8; i < 1536; i++) c1[i] = (Math.random() * 256) | 0
      sock.write(Buffer.concat([Buffer.from([3]), c1]))
    }
    sock.once(secure ? 'secureConnect' : 'connect', start)
    sock.on('data', (d: Buffer) => {
      if (stage === 'hs') {
        hs = Buffer.concat([hs, d])
        if (hs.length < 3073) return
        const s1 = hs.subarray(1, 1537)
        const rest = hs.subarray(3073)
        stage = 'chunks'
        const cs = Buffer.alloc(4)
        cs.writeUInt32BE(OUT)
        sock.write(
          Buffer.concat([
            s1,
            chunked(2, 1, 0, cs, 128),
            chunked(3, 20, 0, amfEncode('connect', 1, { app, type: 'nonprivate', flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)', tcUrl }), OUT)
          ])
        )
        if (rest.length) read(rest)
        return
      }
      read(d)
    })
    sock.on('error', () =>
      done({ ok: false, message: askedPublish ? 'The platform did not accept this key. Copy it again from the platform and save it.' : 'Could not reach the platform. Check the internet connection and the server address.' })
    )
    sock.on('close', () =>
      done({ ok: false, message: askedPublish ? 'The platform did not accept this key. Copy it again from the platform and save it.' : 'The platform closed the connection. Check the server address.' })
    )
  })
}
