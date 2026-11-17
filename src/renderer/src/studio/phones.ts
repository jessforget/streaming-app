/**
 * Phones sending their camera to the main window (see src/server/phones.ts).
 * Each phone is one WebRTC connection. Once its video arrives, it is listed
 * with the other devices as "phone:<id>" (video, and its microphone as audio),
 * so it can be used in a scene like any webcam.
 */
import type { InputDevice } from '../../../shared/state'

export const PHONE_PREFIX = 'phone:'

interface Phone {
  id: string
  name: string
  pc: RTCPeerConnection
  stream: MediaStream
  /** Chrome only lets remote sound into the mixer while a media element plays it too. */
  sink: HTMLAudioElement
  connected: boolean
}

export class PhoneCams {
  private phones = new Map<string, Phone>()
  private listeners = new Set<() => void>()

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
    const phone: Phone = { id: offer.id, name: offer.name, pc, stream, sink, connected: false }
    this.phones.set(offer.id, phone)
    pc.ontrack = (e) => {
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track)
      if (e.track.kind === 'audio') {
        sink.srcObject = stream
        void sink.play().catch(() => {})
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
    return pc.localDescription!.sdp
  }

  /** Connected phones, as devices for the device list. */
  devices(): { video: InputDevice[]; audio: InputDevice[] } {
    const video: InputDevice[] = []
    const audio: InputDevice[] = []
    for (const p of this.phones.values()) {
      if (!p.connected) continue
      const id = PHONE_PREFIX + p.id
      if (p.stream.getVideoTracks().length) video.push({ id, name: `${p.name} (phone)`, group: id })
      if (p.stream.getAudioTracks().length) audio.push({ id, name: `${p.name} (phone mic)`, driver: 'wasapi', group: id, channels: 1 })
    }
    return { video, audio }
  }

  /** The phone's picture and sound, or null while it is not connected. */
  stream(deviceId: string): MediaStream | null {
    const p = this.phones.get(deviceId.slice(PHONE_PREFIX.length))
    return p?.connected ? p.stream : null
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
