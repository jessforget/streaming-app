import type { DataValue, Role } from './protocol'

/**
 * Source types, like OBS's. 'video' is a capture device: the ATEM Mini over
 * USB-C, a HyperDeck through a capture card, or any camera or HDMI capture.
 */
export type LayerKind =
  | 'video'
  | 'screen'
  | 'window'
  | 'image'
  | 'text'
  | 'browser'
  | 'media'
  | 'color'
  | 'countdown'
  | 'slideshow'
  | 'scene'

export const LAYER_KINDS: LayerKind[] = ['video', 'image', 'media', 'text', 'color', 'countdown', 'slideshow', 'scene', 'screen', 'window', 'browser']

/** Where a source sits in the picture. Full = fills it; the rest are boxes and text spots. */
export type Placement = 'full' | 'center' | 'lower-third' | 'top' | 'top-right' | 'bottom-right' | 'top-left'

export const PLACEMENTS: Placement[] = ['full', 'center', 'lower-third', 'top', 'top-right', 'bottom-right', 'top-left']

export const PLACEMENT_LABEL: Record<Placement, string> = {
  full: 'Fill the picture',
  center: 'Centre',
  'lower-third': 'Lower third',
  top: 'Top centre',
  'top-right': 'Small box, top right',
  'bottom-right': 'Small box, bottom right',
  'top-left': 'Small box, top left'
}

/** Where a source is drawn when nobody picked a spot. */
export function placementOf(layer: Layer): Placement {
  if (layer.placement) return layer.placement
  if (layer.kind !== 'text' && layer.kind !== 'countdown') return 'full'
  if (layer.id.endsWith('lower-third')) return 'lower-third'
  if (layer.id.endsWith('score')) return 'top'
  return 'center'
}

export interface Layer {
  id: string
  name: string
  kind: LayerKind
  visible: boolean
  /** Where it sits. Default: video and images fill the picture, text is centred. */
  placement?: Placement
  /** Video layers: which capture device (an id from state.inputs.video). */
  device?: string
  /** Text layers: shown text. `{field.name}` is replaced by that data field's value. */
  text?: string
  /** Image, media and browser layers: file path or URL. Slideshow: a folder of pictures. */
  url?: string
  /** Media: play again from the start when it ends. Default on. */
  loop?: boolean
  /** Media: send the file's sound to the mix while its scene is on air. Default off. */
  sound?: boolean
  /** Media with sound: its volume, 0 to 1. */
  volume?: number
  /** Solid color: CSS hex, like #1e3a8a. */
  color?: string
  /** Countdown: to a time of day ("19:30"), or this many minutes from when its scene goes on air. */
  until?: string
  minutes?: number
  /** Slideshow: seconds per picture. */
  seconds?: number
  /** Scene inside a scene: which scene to show. */
  sceneId?: string
}

export interface Scene {
  id: string
  name: string
  /** Top of the list is drawn in front. */
  layers: Layer[]
  /**
   * Put away in the Scene library: kept with all its sources, but left out of
   * the "In this show" row and the tablet remote. Absent = in this show.
   */
  stored?: boolean
}

/**
 * A mixer channel. 'device' is an audio input (a mic, or the ATEM Mini's USB
 * audio); 'desktop' is the PC's own sound; 'video' is the sound that comes in
 * with a capture device (a HyperDeck or ATEM through a capture card).
 */
export type AudioKind = 'device' | 'desktop' | 'video' | 'file'

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
  /**
   * Which scenes this sound plays in: only while one of them is on air (it
   * fades with the transition). Absent = every scene, like a presenter's mic.
   */
  scenes?: string[]
  /** 'file': a music or sound file (path on this PC). */
  url?: string
  /** 'file': play again from the start when it ends. Default on. */
  loop?: boolean
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
  /** Devices that are one physical box share a group (the ATEM Mini's picture and its sound). */
  group?: string
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

/**
 * The scenes on air right now: the one in Live, plus any scene shown inside
 * it (a "scene" source), so their sound plays too.
 */
export function scenesOnAir(state: Pick<AppState, 'scenes' | 'programSceneId'>, sceneId = state.programSceneId): Set<string> {
  const out = new Set<string>()
  const walk = (id: string) => {
    if (out.has(id) || out.size > 20) return
    const scene = state.scenes.find((s) => s.id === id)
    if (!scene) return
    out.add(id)
    for (const l of scene.layers) if (l.kind === 'scene' && l.visible && l.sceneId) walk(l.sceneId)
  }
  walk(sceneId)
  return out
}

/** Countdown text: "12:04" (or "1:02:03"), counting down to the layer's time of day or minutes. */
export function countdownText(layer: Pick<Layer, 'until' | 'minutes' | 'text'>, now: number, sceneLiveAt: number | undefined): string {
  let end: number
  if (layer.until) {
    const [h, m] = layer.until.split(':').map(Number)
    const d = new Date(now)
    d.setHours(h, m, 0, 0)
    end = d.getTime()
    // Past that time today by over 12 hours: it means tomorrow.
    if (now - end > 12 * 3600_000) end += 24 * 3600_000
  } else {
    end = (sceneLiveAt ?? now) + (layer.minutes ?? 5) * 60_000
  }
  const left = Math.max(0, Math.ceil((end - now) / 1000))
  const hh = Math.floor(left / 3600)
  const mm = Math.floor((left % 3600) / 60)
  const ss = left % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`
  const template = layer.text ?? 'Starting in {time}'
  return template.includes('{time}') ? template.split('{time}').join(time) : `${template} ${time}`.trim()
}

/** True when this sound should be heard with these scenes on air. */
export function audible(a: Pick<AudioSource, 'scenes'>, onAir: Set<string>): boolean {
  return !a.scenes || a.scenes.some((id) => onAir.has(id))
}

/** Audio delay the app allows, in milliseconds (sound can be held back to meet the video, not moved earlier). */
export const SYNC_OFFSET_RANGE = { min: 0, max: 5000 }

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
  /** The saved key's last 4 characters, to match against the platform's. */
  keyEnd?: string
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
  /** 'live' = cameras and sound are real; 'simulated' = practice mode, nothing is captured or sent. */
  mode: 'live' | 'simulated'
  note: string
}

/** 'pal' = 25 or 50 frames a second (Europe, Africa, Middle East...); 'ntsc' = 30 or 60. */
export type FpsFamily = 'pal' | 'ntsc'
export type FrameRateChoice = 'auto' | FpsFamily

export interface AppState {
  setupName: string
  engine: EngineInfo
  scenes: Scene[]
  previewSceneId: string
  programSceneId: string
  transition: { kind: 'cut' | 'fade'; durationMs: number }
  audio: AudioSource[]
  stream: {
    live: boolean
    startedAt: number | null
    quality: Quality
    destinations: Destination[]
    /** The person's choice: match the cameras, or always 25/50 or 30/60 frames a second. */
    frameRate: FrameRateChoice
    /** What the cameras send, measured by the main window. family null = no camera to go by. */
    cameras: { family: FpsFamily | null; note: string }
    /** The frame rate family in use now. Only changes while not streaming or recording. */
    family: FpsFamily
  }
  recording: { active: boolean; startedAt: number | null; folder: string; format: 'mp4' | 'mkv' }
  /** Devices the PC can see, for the source and audio pickers. */
  inputs: { video: InputDevice[]; audio: InputDevice[] }
  data: Record<string, DataField>
  devices: { pairingOpen: boolean; pairingCode: string; controlUrl: string; list: PairedDevice[] }
  stats: HealthStats
}
