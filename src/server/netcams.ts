/**
 * Network cameras, two ways:
 *
 * - The app reads the camera: a Z CAM E2 (or another camera with an RTSP
 *   stream) plugged into the router. ffmpeg reads it here. These are listed
 *   in Settings by address and kept in netcams.json in the data folder.
 * - The camera sends to the app: any camera that can live stream (RTMP), to
 *   the one address in Settings. Nothing to list: each stream that arrives
 *   shows up by its stream key (see rtmp.ts).
 *
 * Either way the H.264 video goes, unchanged, to the main window over a
 * WebSocket; the main window decodes it with the browser's video decoder
 * (graphics card) and lists it with the other cameras as "net:<id>". Nothing
 * is re-encoded, so it costs very little. Only the main window on this PC
 * can see the list or open a camera's video.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WebSocket } from 'ws'
import type { RtmpReceiver } from './rtmp'

export interface NetCam {
  id: string
  name: string
  /** 'pull': the app reads the camera (Z CAM). 'receive': the camera streams to the app (listed while it does). */
  mode: 'pull' | 'receive'
  /** Pull: what the person typed, an address (192.168.101.40) or a full rtsp:// link. */
  address: string
  /** Receive: why its picture can't be shown (an H.265 camera), if it can't. */
  problem?: string
}

const MAX_CAMS = 8
const RETRY_MS = [1000, 2000, 5000, 10000]

/** The camera's stream link. A bare address means a Z CAM (its stream is at /live_stream). */
export function rtspUrl(address: string): string {
  const a = address.trim()
  if (/^rtsp:\/\//i.test(a)) return a
  return `rtsp://${a.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')}/live_stream`
}

/** Keep only well-formed cameras to read (the list comes from the page). */
export function cleanCams(input: unknown): NetCam[] {
  if (!Array.isArray(input)) return []
  const out: NetCam[] = []
  for (const c of input.slice(0, MAX_CAMS)) {
    if (!c || typeof c !== 'object') continue
    const { id, name, address, mode } = c as Record<string, unknown>
    // Cameras that stream to the app aren't kept: they show up by themselves.
    if (mode === 'receive' || typeof address !== 'string') continue
    const cleanId = typeof id === 'string' && /^[a-z0-9]{1,24}$/i.test(id) && !id.startsWith('rtmp') ? id : Math.random().toString(36).slice(2, 10)
    const cleanName = typeof name === 'string' ? name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) : ''
    if (out.some((o) => o.id === cleanId)) continue
    const addr = address.trim().slice(0, 300)
    // An address or host name, or an rtsp:// link. No spaces or quotes: it goes on ffmpeg's command line.
    if (!/^(rtsp:\/\/)?[\w.\-:@%/?=&~+]+$/i.test(addr)) continue
    out.push({ id: cleanId, name: cleanName || 'Network camera', mode: 'pull', address: addr })
  }
  return out
}

/**
 * Splits an H.264 byte stream (Annex B, start codes) into whole pictures
 * ("access units"), which is what the browser's decoder wants, one at a time.
 */
export class AccessUnits {
  private buf: Buffer = Buffer.alloc(0)
  private nals: Buffer[] = []
  private hasSlice = false

  constructor(private readonly onUnit: (unit: Buffer, key: boolean) => void) {}

  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    let start = findStart(this.buf, 0)
    if (start < 0) return
    for (;;) {
      const next = findStart(this.buf, start + 3)
      if (next < 0) break
      this.nal(this.buf.subarray(start, next))
      start = next
    }
    this.buf = Buffer.from(this.buf.subarray(start))
  }

  private nal(nal: Buffer) {
    const off = nal[2] === 1 ? 3 : 4
    const type = nal[off] & 0x1f
    const isSlice = type === 1 || type === 5
    // first_mb_in_slice == 0 (its first bit is 1): a new picture starts.
    const firstSlice = isSlice && (nal[off + 1] & 0x80) !== 0
    const startsUnit = (type === 9 || type === 7 || type === 8 || type === 6 || firstSlice) && this.hasSlice
    if (startsUnit) this.flush()
    this.nals.push(nal)
    if (isSlice) this.hasSlice = true
  }

  private flush() {
    const key = this.nals.some((n) => (n[n[2] === 1 ? 3 : 4] & 0x1f) === 5)
    this.onUnit(Buffer.concat(this.nals), key)
    this.nals = []
    this.hasSlice = false
  }
}

function findStart(b: Buffer, from: number): number {
  for (let i = from; i + 2 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0) {
      if (b[i + 2] === 1) return i > 0 && b[i - 1] === 0 ? i - 1 : i
    }
  }
  return -1
}

/** "avc1.640028" from the stream's settings (SPS), so the decoder knows the profile and level. */
export function codecFromUnit(unit: Buffer): string | null {
  let i = findStart(unit, 0)
  while (i >= 0) {
    const off = i + (unit[i + 2] === 1 ? 3 : 4)
    if ((unit[off] & 0x1f) === 7 && off + 3 < unit.length) {
      const hex = (n: number) => n.toString(16).padStart(2, '0')
      return `avc1.${hex(unit[off + 1])}${hex(unit[off + 2])}${hex(unit[off + 3])}`
    }
    i = findStart(unit, off)
  }
  return null
}

export class NetCamHub {
  private cams: NetCam[]

  constructor(
    private readonly file: string,
    private readonly ffmpeg: string | null,
    private readonly log: (line: string) => void = () => {},
    private readonly rtmp: RtmpReceiver | null = null
  ) {
    this.cams = this.load()
  }

  /** The cameras to read, then the cameras streaming to the app right now. */
  list(): NetCam[] {
    const live = (this.rtmp?.list() ?? []).map((s) => ({ id: s.id, name: s.name, mode: 'receive' as const, address: s.from, problem: s.problem }))
    return [...this.cams, ...live]
  }

  /** Change the cameras to read (cameras that stream to the app aren't listed by hand). */
  set(input: unknown): NetCam[] {
    this.cams = cleanCams(input)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.cams, null, 2))
    } catch (e) {
      this.log(`! could not save network cameras: ${String(e)}`)
    }
    return this.list()
  }

  /**
   * The main window opened one camera's video, for as long as it stays connected.
   *
   * Messages to the window: text {"type":"codec"} / {"type":"status"}, and binary
   * pictures: one byte (1 = key picture) followed by the H.264 picture (Annex B).
   */
  attach(socket: WebSocket, id: string) {
    socket.on('error', () => socket.terminate())
    if (id.startsWith('rtmp-')) return this.attachRtmp(socket, id)
    const cam = this.cams.find((c) => c.id === id)
    if (!cam) return void socket.close(4404, 'Unknown camera')
    if (!this.ffmpeg) {
      socket.send(JSON.stringify({ type: 'status', ok: false, message: 'ffmpeg not found' }))
      return void socket.close(4500, 'No ffmpeg')
    }
    let proc: ChildProcessWithoutNullStreams | null = null
    let closed = false
    let tries = 0
    let codec = ''
    let retry: ReturnType<typeof setTimeout> | null = null
    const status = (ok: boolean, message: string) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'status', ok, message }))
    }
    const run = () => {
      if (closed) return
      // UDP, not TCP: the Z CAM's RTSP server drops a TCP viewer about once a minute (seen on the E2).
      // No buffering: lowest delay.
      proc = spawn(
        this.ffmpeg!,
        ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay', '-rtsp_transport', 'udp',
          '-buffer_size', '4194304', '-timeout', '5000000', '-i', rtspUrl(cam.address),
          '-map', '0:v:0', '-an', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1'],
        { windowsHide: true }
      )
      let got = false
      let err = ''
      const units = new AccessUnits((unit, key) => {
        if (!got) {
          got = true
          tries = 0
          status(true, 'Connected')
          this.log(`network camera "${cam.name}" connected`)
        }
        if (key) {
          const c = codecFromUnit(unit)
          if (c && c !== codec) {
            codec = c
            socket.send(JSON.stringify({ type: 'codec', codec }))
          }
        }
        if (codec) sendPicture(socket, unit, key)
      })
      proc.stdout.on('data', (c: Buffer) => units.push(c))
      proc.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-500)))
      proc.on('close', () => {
        proc = null
        if (closed) return
        const why = err.trim().split('\n').pop() ?? ''
        this.log(`network camera "${cam.name}" stopped${why ? `: ${why}` : ''}`)
        status(false, got ? 'Camera disconnected, trying again' : 'Cannot reach the camera, trying again')
        codec = ''
        retry = setTimeout(run, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)])
      })
      proc.on('error', () => {})
    }
    status(false, 'Connecting')
    run()
    socket.on('close', () => {
      closed = true
      if (retry) clearTimeout(retry)
      proc?.kill()
    })
  }

  /** A camera streaming to the app: pass its pictures on, from the next key picture. */
  private attachRtmp(socket: WebSocket, id: string) {
    if (!this.rtmp) return void socket.close(4404, 'Receiving is off')
    let codec = ''
    const off = this.rtmp.subscribe(
      id,
      (pic) => {
        if (codec) sendPicture(socket, pic.data, pic.key)
      },
      (c) => {
        codec = c
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'codec', codec }))
          socket.send(JSON.stringify({ type: 'status', ok: true, message: 'Connected' }))
        }
      }
    )
    if (!off) return void socket.close(4404, 'Not streaming')
    const since = this.rtmp.list().find((x) => x.id === id)?.since
    // The camera's settings may arrive a moment after it starts: check again until they do.
    const wait = setInterval(() => {
      const s = this.rtmp!.list().find((x) => x.id === id)
      if (!s) return socket.close(4410, 'The camera stopped streaming')
      // The camera reconnected with the same key: start over on its new stream.
      if (s.since !== since) return socket.close(4409, 'The camera reconnected')
      if (!codec && s.codec) {
        codec = s.codec
        socket.send(JSON.stringify({ type: 'codec', codec }))
        socket.send(JSON.stringify({ type: 'status', ok: true, message: 'Connected' }))
      }
    }, 500)
    socket.on('close', () => {
      clearInterval(wait)
      off()
    })
  }

  private load(): NetCam[] {
    try {
      return cleanCams(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return []
    }
  }
}

/** One picture to the window. When the window falls behind (slow PC), drop pictures until the next key picture. */
function sendPicture(socket: WebSocket, unit: Buffer, key: boolean) {
  if (socket.readyState !== socket.OPEN) return
  if (socket.bufferedAmount > 8 * 1024 * 1024 && !key) return
  socket.send(Buffer.concat([Buffer.from([key ? 1 : 0]), unit]))
}
