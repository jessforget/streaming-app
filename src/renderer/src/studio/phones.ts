/**
 * Phones sending their camera to the main window (see src/server/phones.ts).
 * Each phone is one WebRTC connection. Once its video arrives, it is listed
 * with the other devices as "phone:<id>" (video, and its microphone as audio),
 * so it can be used in a scene like any webcam.
 */
import type { InputDevice, PhoneCamValue, PhoneFacing } from '../../../shared/state'

export const PHONE_PREFIX = 'phone:'

interface Phone {
  id: string
  name: string
  pc: RTCPeerConnection
  stream: MediaStream
  /** Chrome only lets remote sound into the mixer while a media element plays it too. */
  sink: HTMLAudioElement
  connected: boolean
  /** A small message link to the phone page (its camera flip), once the phone opens it. */
  ctl: RTCDataChannel | null
  /** Which camera the phone says it is sending. */
  facing?: PhoneFacing
  /** The camera settings the phone allows, as it describes them (checked again by the app's server). */
  camera?: unknown[]
  /** The last connection sample, to turn totals into rates. */
  lastStats?: { at: number; bytes: number; lost: number; received: number }
}

/** How a phone's picture is arriving: what to look at when it's blocky or behind. */
export interface PhoneLinkStats {
  width: number
  height: number
  fps: number
  /** Megabits a second arriving now. */
  mbps: number
  /** Packets lost in the last moment, in percent. */
  lossPct: number
  /** How far behind the picture plays (the playback buffer), in ms. */
  delayMs: number
  codec: string
}

export class PhoneCams {
  private phones = new Map<string, Phone>()
  private listeners = new Set<() => void>()
  private facingListeners = new Set<() => void>()
  /** A phone switched between its front and back camera. */
  onFacing(fn: () => void) {
    this.facingListeners.add(fn)
    return () => this.facingListeners.delete(fn)
  }

  /** Answer one phone's offer; the video arrives a moment later. */
  async answer(offer: { id: string; name: string; sdp: string }): Promise<string> {
    if (!offer.sdp) {
      // The phone said goodbye.
      this.drop(offer.id)
      return ''
    }
    this.drop(offer.id, false)
    const pc = new RTCPeerConnection({ iceServers: [] })
    const stream = new MediaStream()
    const sink = new Audio()
    sink.muted = true
    const phone: Phone = { id: offer.id, name: offer.name, pc, stream, sink, connected: false, ctl: null }
    this.phones.set(offer.id, phone)
    pc.ontrack = (e) => {
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track)
      // A short playback buffer: less delay (it still grows by itself when the Wi-Fi gets rough).
      const r = e.receiver as unknown as { jitterBufferTarget?: number | null; playoutDelayHint?: number }
      try {
        if ('jitterBufferTarget' in r) r.jitterBufferTarget = 120
        else r.playoutDelayHint = 0.12
      } catch {
        // not in this browser
      }
      if (e.track.kind === 'audio') {
        sink.srcObject = stream
        void sink.play().catch(() => {})
      }
    }
    pc.ondatachannel = (e) => {
      if (e.channel.label !== 'control') return
      phone.ctl = e.channel
      e.channel.onmessage = (m) => {
        if (this.phones.get(offer.id) !== phone || typeof m.data !== 'string' || m.data.length > 1000) return
        try {
          const msg = JSON.parse(m.data)
          if ((msg.facing === 'user' || msg.facing === 'environment') && msg.facing !== phone.facing) {
            phone.facing = msg.facing
            // Same picture track, other camera: only the device list changes (no reopening the video).
            this.facingListeners.forEach((fn) => fn())
          }
          if (Array.isArray(msg.camera)) {
            phone.camera = msg.camera.slice(0, 12)
            this.facingListeners.forEach((fn) => fn())
          }
        } catch {
          // not ours
        }
      }
    }
    pc.onconnectionstatechange = () => {
      if (this.phones.get(offer.id) !== phone) return
      const s = pc.connectionState
      if (s === 'connected' && !phone.connected) {
        phone.connected = true
        this.changed()
      } else if (s === 'failed' || s === 'closed') {
        this.drop(offer.id)
      } else if (s === 'disconnected') {
        // A phone that stopped or lost Wi-Fi: give it a few seconds to come back, then list it as gone.
        setTimeout(() => {
          if (this.phones.get(offer.id) === phone && pc.connectionState === 'disconnected') this.drop(offer.id)
        }, 4000)
      }
    }
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    await pc.setLocalDescription(await pc.createAnswer())
    await iceGathered(pc)
    return startSharp(pc.localDescription!.sdp)
  }

  /** Connected phones, as devices for the device list. */
  devices(): { video: InputDevice[]; audio: InputDevice[] } {
    const video: InputDevice[] = []
    const audio: InputDevice[] = []
    for (const p of this.phones.values()) {
      if (!p.connected) continue
      const id = PHONE_PREFIX + p.id
      if (p.stream.getVideoTracks().length) video.push({ id, name: `${p.name} (phone)`, group: id, ...(p.facing ? { facing: p.facing } : {}), ...(p.camera ? { camera: p.camera as InputDevice['camera'] } : {}) })
      if (p.stream.getAudioTracks().length) audio.push({ id, name: `${p.name} (phone mic)`, driver: 'wasapi', group: id, channels: 1 })
    }
    return { video, audio }
  }

  /** The phone's picture and sound, or null while it is not connected. */
  stream(deviceId: string): MediaStream | null {
    const p = this.phones.get(deviceId.slice(PHONE_PREFIX.length))
    return p?.connected ? p.stream : null
  }

  /** How this phone's picture is arriving now (resolution, frame rate, bitrate, loss, delay). */
  async linkStats(deviceId: string): Promise<PhoneLinkStats | null> {
    const p = this.phones.get(deviceId.slice(PHONE_PREFIX.length))
    if (!p?.connected) return null
    const report = await p.pc.getStats()
    let inbound: Record<string, number | string | undefined> | null = null
    const codecs = new Map<string, string>()
    report.forEach((s: Record<string, unknown> & { type: string; id: string }) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s as Record<string, number | string | undefined>
      if (s.type === 'codec' && typeof s.mimeType === 'string') codecs.set(s.id, s.mimeType.replace(/^video\//, ''))
    })
    if (!inbound) return null
    const r = inbound as Record<string, number | string | undefined>
    const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0)
    const now = performance.now()
    const bytes = num('bytesReceived')
    const lost = num('packetsLost')
    const received = num('packetsReceived')
    const last = p.lastStats
    p.lastStats = { at: now, bytes, lost, received }
    const dt = last ? (now - last.at) / 1000 : 0
    const dLost = last ? lost - last.lost : 0
    const dGot = last ? received - last.received : 0
    const emitted = num('jitterBufferEmittedCount')
    return {
      width: num('frameWidth'),
      height: num('frameHeight'),
      fps: Math.round(num('framesPerSecond')),
      mbps: dt > 0 ? Math.round(((bytes - last!.bytes) * 8) / dt / 1e4) / 100 : 0,
      lossPct: dLost + dGot > 0 ? Math.round((1000 * Math.max(0, dLost)) / (dLost + dGot)) / 10 : 0,
      delayMs: emitted ? Math.round((1000 * num('jitterBufferDelay')) / emitted) : 0,
      codec: codecs.get(String(r.codecId ?? '')) ?? ''
    }
  }

  /** The phone's name and camera, for the Camera panel. */
  info(deviceId: string): { name: string; facing?: PhoneFacing } | null {
    const p = this.phones.get(deviceId.slice(PHONE_PREFIX.length))
    return p?.connected ? { name: p.name, facing: p.facing } : null
  }

  /** Ask a phone to switch to its front or back camera. False when it can't be told (an older phone page). */
  flip(deviceId: string, facing: PhoneFacing): boolean {
    return this.tell(deviceId, { facing })
  }

  /** Change a phone camera's settings (exposure, white balance, focus...). */
  setCamera(deviceId: string, set: Record<string, PhoneCamValue>): boolean {
    return this.tell(deviceId, { set })
  }

  private tell(deviceId: string, msg: object): boolean {
    const p = this.phones.get(deviceId.slice(PHONE_PREFIX.length))
    if (!p?.ctl || p.ctl.readyState !== 'open') return false
    p.ctl.send(JSON.stringify(msg))
    return true
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close() {
    for (const id of [...this.phones.keys()]) this.drop(id, false)
  }

  private drop(id: string, notify = true) {
    const p = this.phones.get(id)
    if (!p) return
    this.phones.delete(id)
    p.sink.srcObject = null
    p.pc.close()
    if (notify && p.connected) this.changed()
  }

  private changed() {
    this.listeners.forEach((fn) => fn())
  }
}

function iceGathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return
      pc.removeEventListener('icegatheringstatechange', done)
      resolve()
    }
    pc.addEventListener('icegatheringstatechange', done)
    setTimeout(resolve, 3000)
  })
}

/**
 * Ask the phone to start at a good bitrate and not go below a floor (Chrome on the phone reads
 * these from our answer). Without it a phone starts near 0.3 Mbps and climbs slowly: blocky.
 */
export function startSharp(sdp: string, startKbps = 3500, minKbps = 2500, maxKbps = 8000): string {
  const extra = `x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`
  const lines = sdp.split('\r\n')
  let video = false
  const pts = new Set<string>()
  for (const l of lines) {
    if (l.startsWith('m=')) video = l.startsWith('m=video')
    const m = video && /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(l)
    if (m) pts.add(m[1])
  }
  const out: string[] = []
  const hasFmtp = new Set(lines.map((l) => /^a=fmtp:(\d+) /.exec(l)?.[1]).filter((x): x is string => !!x))
  for (const l of lines) {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(l)
    if (f && pts.has(f[1]) && !f[2].includes('x-google-')) {
      out.push(`${l};${extra}`)
      continue
    }
    out.push(l)
    const r = /^a=rtpmap:(\d+) /.exec(l)
    if (r && pts.has(r[1]) && !hasFmtp.has(r[1])) out.push(`a=fmtp:${r[1]} ${extra}`)
  }
  return out.join('\r\n')
}
