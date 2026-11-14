import type { DataValue, Role } from './protocol'

/**
 * Source types, like OBS's. 'video' is a capture device: the ATEM Mini over
 * USB-C, a HyperDeck through a capture card, or any camera or HDMI capture.
 */
export type LayerKind = 'video' | 'screen' | 'window' | 'image' | 'text' | 'browser' | 'media'

export const LAYER_KINDS: LayerKind[] = ['video', 'image', 'text', 'browser', 'media', 'screen', 'window']

export interface Layer {
  id: string
  name: string
  kind: LayerKind
  visible: boolean
  /** Video layers: which capture device (an id from state.inputs.video). */
  device?: string
  /** Text layers: shown text. `{field.name}` is replaced by that data field's value. */
  text?: string
  /** Image, media and browser layers: file path or URL. */
  url?: string
}

export interface Scene {
  id: string
  name: string
  /** Top of the list is drawn in front. */
  layers: Layer[]
}

/**
 * A mixer channel. 'device' is an audio input (a mic, or the ATEM Mini's USB
 * audio); 'desktop' is the PC's own sound; 'video' is the sound that comes in
 * with a capture device (a HyperDeck or ATEM through a capture card).
 */
export type AudioKind = 'device' | 'desktop' | 'video'

export interface AudioSource {
  id: string
  name: string
  kind: AudioKind
  /** For 'device' and 'video': which device (an id from state.inputs). */
  device?: string
  /**
   * For multichannel audio interfaces (Zoom L-12, Focusrite Scarlett): which
   * input channels this mixer channel takes, counted from 1. One entry = a mono
   * input (a mic), two = a stereo pair. Absent = the device's first pair.
   */
  channels?: number[]
  /** Delay (or advance, if negative) this sound to line it up with the video, in milliseconds. */
  syncOffsetMs: number
  /** 0 to 1 */
  volume: number
  muted: boolean
  /** Latest peak level, 0 to 1. Updated with stats. */
  level: number
}

/** A capture or audio device the PC can see. */
export interface InputDevice {
  id: string
  name: string
  /** Audio devices: how they're reached. ASIO lets you pick single channels of a multichannel interface. */
  driver?: 'wasapi' | 'asio'
  /** Audio devices: number of input channels, when known. */
  channels?: number
  /** Audio devices: each input channel's name from the driver ("Ch 1", "Analogue 3"), when it gives them. */
  channelNames?: string[]
}

/**
 * Windows names audio inputs "<what> (<device>)", for example
 * "Microphone (2- ZOOM L-12 Audio)". Show the device first, the way people
 * know it: "ZOOM L-12 Audio · Microphone".
 */
export function audioDeviceName(raw: string): string {
  const m = /^(.*?)\s*\((?:\d+-\s*)?(.+)\)\s*$/.exec(raw.trim())
  if (!m || !m[1]) return raw.trim()
  return `${m[2].trim()} · ${m[1].trim()}`
}

/** Name of one input channel: the driver's name when known, else "Ch 3". */
export function channelName(d: InputDevice | undefined, ch: number): string {
  return d?.channelNames?.[ch - 1] ?? `Ch ${ch}`
}

/** Longest audio delay the app allows, in milliseconds (and -950 the most it can be moved earlier). */
export const SYNC_OFFSET_RANGE = { min: -950, max: 5000 }

/** How many input channels an audio device can offer the channel picker. */
export function channelCount(d: InputDevice | undefined): number {
  return d?.channels ?? (d?.driver === 'asio' ? 32 : 2)
}

export type Platform = 'youtube' | 'facebook' | 'instagram' | 'twitch' | 'kick' | 'custom'

export interface Destination {
  id: string
  platform: Platform
  enabled: boolean
  /** Only for platforms without a fixed ingest address (Instagram, Kick, custom). */
  serverUrl?: string
  /** True when a stream key is saved. The key itself never leaves the streaming PC. */
  hasKey: boolean
  /** Instagram streams in a vertical layout. */
  vertical: boolean
}

export type Quality = 'low' | 'medium' | 'high'

export interface DataField {
  value: DataValue
  updatedAt: number
  /** Name of the device that sent it. */
  source: string
}

export interface PairedDevice {
  id: string
  name: string
  role: Role
  connected: boolean
  pairedAt: number
}

export type Health = 'good' | 'warning' | 'bad' | 'idle'

export interface HealthStats {
  health: Health
  /** Plain-words explanation shown in the health bar. */
  message: string
  fps: number
  cpu: number
  droppedFrames: number
  totalFrames: number
  /** Total upload needed by all enabled destinations, kbps. */
  requiredKbps: number
  /** Peak level per audio source, 0 to 1, for the meters. */
  audioLevels: Record<string, number>
}

export interface EngineInfo {
  /** 'obs' = real video engine; 'simulated' = practice mode, nothing is captured or sent. */
  mode: 'obs' | 'simulated'
  note: string
}

export interface AppState {
  setupName: string
  engine: EngineInfo
  scenes: Scene[]
  previewSceneId: string
  programSceneId: string
  transition: { kind: 'cut' | 'fade'; durationMs: number }
  audio: AudioSource[]
  stream: { live: boolean; startedAt: number | null; quality: Quality; destinations: Destination[] }
  recording: { active: boolean; startedAt: number | null; folder: string; format: 'mp4' | 'mkv' }
  /** Devices the PC can see, for the source and audio pickers. */
  inputs: { video: InputDevice[]; audio: InputDevice[] }
  data: Record<string, DataField>
  devices: { pairingOpen: boolean; pairingCode: string; controlUrl: string; list: PairedDevice[] }
  stats: HealthStats
}
