/**
 * Network cameras in the main window (see src/server/netcams.ts). The app's
 * server reads each camera's stream and sends its H.264 pictures here; the
 * browser's video decoder (graphics card) turns them back into a picture.
 * Each camera is listed with the other devices as "net:<id>", so it is used
 * in a scene like any webcam or phone.
 */
import type { InputDevice } from '../../../shared/state'

export const NET_PREFIX = 'net:'

/** Window event Settings sends after saving the camera list; the detail is the new list. */
export const NETCAMS_CHANGED = 'streaming-app:netcams-changed'

export interface NetCamConfig {
  id: string
  name: string
  /** 'pull': the app reads the camera (Z CAM). 'receive': the camera sends to the app (Sony). */
  mode?: 'pull' | 'receive'
  /** Pull: the camera's address. Receive: where it streams from. */
  address: string
  /** Receive: why its picture can't be shown, if it can't. */
  problem?: string
}

interface Cam {
  cfg: NetCamConfig
  ws: WebSocket | null
  decoder: VideoDecoder | null
  codec: string
  needKey: boolean
  stream: MediaStream
  /** Draws each decoded picture into the stream. */
  put: (frame: VideoFrame) => void
  stopTrack: () => void
  connected: boolean
  message: string
  retry: ReturnType<typeof setTimeout> | null
  /** Picture time for the decoder, in microseconds: it only needs to go up. */
  ts: number
  /** When the last pictures arrived (ms), to measure the camera's frame rate. */
  arrivals: number[]
  /** The camera's frame rate (25, 29.97, 50...), once measured; 0 until then. */
  fps: number
}

/** Frame rates cameras send. A measured rate is snapped to the nearest one. */
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]

/** The camera's frame rate from when its pictures arrived (over about 3 s), or 0 if unclear. */
export function measureFps(arrivals: number[]): number {
  if (arrivals.length < 20) return 0
  const span = arrivals[arrivals.length - 1] - arrivals[0]
  if (span < 2000) return 0
  const raw = ((arrivals.length - 1) * 1000) / span
  let best = 0
  for (const f of STANDARD_FPS) if (!best || Math.abs(f - raw) < Math.abs(best - raw)) best = f
  // Too far from any (a stalling camera): not sure yet.
  return Math.abs(best - raw) / best < 0.04 ? best : 0
}

/** A video track fed one picture at a time: the browser's track generator, or a canvas where there is none. */
function makeTrack(): { stream: MediaStream; put: (f: VideoFrame) => void; stop: () => void } {
  const Gen = (globalThis as unknown as { MediaStreamTrackGenerator?: new (o: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> } })
    .MediaStreamTrackGenerator
  if (Gen) {
    const track = new Gen({ kind: 'video' })
    const writer = track.writable.getWriter()
    let busy = false
    return {
      stream: new MediaStream([track]),
      put: (f) => {
        // One picture waiting at most: a late one is dropped instead of adding delay.
        if (busy) return f.close()
        busy = true
        writer.write(f).then(
          () => (busy = false),
          () => (busy = false)
        )
      },
      stop: () => track.stop()
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1920
  canvas.height = 1080
  const ctx = canvas.getContext('2d', { alpha: false })!
  const stream = canvas.captureStream()
  return {
    stream,
    put: (f) => {
      if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
        canvas.width = f.displayWidth
        canvas.height = f.displayHeight
      }
      ctx.drawImage(f, 0, 0)
      f.close()
    },
    stop: () => stream.getTracks().forEach((t) => t.stop())
  }
}

export class NetCams {
  private cams = new Map<string, Cam>()
  private listeners = new Set<() => void>()
  private closed = false
  private offWindow: (() => void) | null = null

  /** Load the camera list from the app and connect to each camera. */
  async load() {
    // Settings saved a new list (same window).
    const onChange = (e: Event) => this.apply((e as CustomEvent<NetCamConfig[]>).detail ?? [])
    window.addEventListener(NETCAMS_CHANGED, onChange)
    this.offWindow = () => window.removeEventListener(NETCAMS_CHANGED, onChange)
    // Cameras that stream to the app come and go by themselves: look every 2 seconds.
    const poll = async () => {
      try {
        const r = await fetch('/api/netcams')
        if (!r.ok) return false
        const b = (await r.json()) as { cams?: NetCamConfig[] }
        if (!this.closed) this.apply(b.cams ?? [])
        return true
      } catch {
        return true
      }
    }
    // Not available at all (the demo page): don't keep asking.
    if (!(await poll()) || this.closed) return
    const timer = setInterval(() => void poll(), 2000)
    const offWin = this.offWindow
    this.offWindow = () => {
      offWin?.()
      clearInterval(timer)
    }
  }

  /** The camera list changed (Settings): connect new ones, drop removed ones. */
  apply(list: NetCamConfig[]) {
    const keep = new Set(list.map((c) => c.id))
    for (const id of [...this.cams.keys()]) if (!keep.has(id)) this.drop(id)
    for (const cfg of list) {
      const old = this.cams.get(cfg.id)
      if (old && (cfg.mode === 'receive' || old.cfg.address === cfg.address) && old.cfg.mode === cfg.mode) {
        old.cfg = cfg
        continue
      }
      if (old) this.drop(cfg.id)
      this.open(cfg)
    }
    this.changed()
  }

  /** Cameras sending a picture, as devices for the device list. */
  devices(): { video: InputDevice[]; audio: InputDevice[] } {
    const video: InputDevice[] = []
    for (const c of this.cams.values()) {
      if (c.connected) video.push({ id: NET_PREFIX + c.cfg.id, name: `${c.cfg.name} (network)`, group: NET_PREFIX + c.cfg.id })
    }
    return { video, audio: [] }
  }

  /** How each camera is doing, for Settings. */
  statuses(): Record<string, { connected: boolean; message: string }> {
    const out: Record<string, { connected: boolean; message: string }> = {}
    for (const c of this.cams.values()) out[c.cfg.id] = { connected: c.connected, message: c.message }
    return out
  }

  /** A connected camera's frame rate, once measured (0 until then). */
  fps(deviceId: string): number {
    const c = this.cams.get(deviceId.slice(NET_PREFIX.length))
    return c?.connected ? c.fps : 0
  }

  stream(deviceId: string): MediaStream | null {
    const c = this.cams.get(deviceId.slice(NET_PREFIX.length))
    return c?.connected ? c.stream : null
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close() {
    this.closed = true
    this.offWindow?.()
    for (const id of [...this.cams.keys()]) this.drop(id)
  }

  private open(cfg: NetCamConfig) {
    const t = makeTrack()
    const cam: Cam = {
      cfg,
      ws: null,
      decoder: null,
      codec: '',
      needKey: true,
      stream: t.stream,
      put: t.put,
      stopTrack: t.stop,
      connected: false,
      message: 'Connecting',
      retry: null,
      ts: 0,
      arrivals: [],
      fps: 0
    }
    this.cams.set(cfg.id, cam)
    this.connect(cam)
  }

  private connect(cam: Cam) {
    if (this.closed || this.cams.get(cam.cfg.id) !== cam) return
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/netcam?id=${encodeURIComponent(cam.cfg.id)}`)
    ws.binaryType = 'arraybuffer'
    cam.ws = ws
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') return this.onText(cam, e.data)
      this.onPicture(cam, new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = () => {
      if (cam.ws !== ws) return
      cam.ws = null
      this.setConnected(cam, false, 'The app lost the camera, trying again')
      cam.retry = setTimeout(() => this.connect(cam), 3000)
    }
  }

  private onText(cam: Cam, text: string) {
    let m: { type?: string; codec?: string; ok?: boolean; message?: string }
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (m.type === 'codec' && m.codec && m.codec !== cam.codec) {
      cam.codec = m.codec
      this.makeDecoder(cam)
    } else if (m.type === 'status') {
      cam.message = m.message ?? ''
      if (!m.ok) this.setConnected(cam, false, cam.message)
      else this.changed()
    }
  }

  private makeDecoder(cam: Cam) {
    if (cam.decoder && cam.decoder.state !== 'closed') cam.decoder.close()
    if (typeof VideoDecoder === 'undefined') {
      cam.message = 'This browser cannot decode the camera. Use Chrome, Edge or the desktop version.'
      return this.changed()
    }
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.cams.get(cam.cfg.id) !== cam) return frame.close()
        cam.put(frame)
        if (!cam.connected) this.setConnected(cam, true, 'Connected')
      },
      error: () => {
        // A damaged picture: start again from the next key picture.
        if (cam.decoder === decoder) {
          cam.decoder = null
          cam.needKey = true
          if (cam.codec) this.makeDecoder(cam)
        }
      }
    })
    decoder.configure({ codec: cam.codec, optimizeForLatency: true })
    cam.decoder = decoder
    cam.needKey = true
  }

  private onPicture(cam: Cam, msg: Uint8Array) {
    if (msg.length < 2) return
    this.countArrival(cam)
    const d = cam.decoder
    if (!d || d.state !== 'configured') return
    const key = msg[0] === 1
    if (cam.needKey && !key) return
    // The decoder is behind: skip to the next key picture instead of piling up delay.
    if (d.decodeQueueSize > 10 && !key) {
      cam.needKey = true
      return
    }
    cam.needKey = false
    cam.ts += Math.round(1e6 / (cam.fps || 25))
    try {
      d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: cam.ts, data: msg.subarray(1) }))
    } catch {
      cam.needKey = true
    }
  }

  /** Keep the last ~3 s of arrival times and re-measure the frame rate once a second's worth. */
  private countArrival(cam: Cam) {
    const now = performance.now()
    const a = cam.arrivals
    a.push(now)
    while (a.length && now - a[0] > 3000) a.shift()
    if (a.length % 25 !== 0) return
    const fps = measureFps(a)
    if (fps && fps !== cam.fps) {
      cam.fps = fps
      this.changed()
    }
  }

  private setConnected(cam: Cam, on: boolean, message: string) {
    if (!on) {
      cam.arrivals = []
      cam.fps = 0
    }
    cam.message = message
    if (cam.connected === on) return this.changed()
    cam.connected = on
    this.changed()
  }

  private drop(id: string) {
    const c = this.cams.get(id)
    if (!c) return
    this.cams.delete(id)
    if (c.retry) clearTimeout(c.retry)
    const ws = c.ws
    c.ws = null
    ws?.close()
    if (c.decoder && c.decoder.state !== 'closed') c.decoder.close()
    c.stopTrack()
  }

  private changed() {
    this.listeners.forEach((fn) => fn())
  }
}
