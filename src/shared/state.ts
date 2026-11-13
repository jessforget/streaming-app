import type { DataValue, Role } from './protocol'

export type LayerKind =
  | 'atem'
  | 'webcam'
  | 'screen'
  | 'window'
  | 'image'
  | 'text'
  | 'browser'
  | 'media'

export interface Layer {
  id: string
  name: string
  kind: LayerKind
  visible: boolean
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
  /** Optional: switching this scene live also puts this ATEM input on air. */
  atemInput?: number
}

export interface AudioSource {
  id: string
  name: string
  /** 0 to 1 */
  volume: number
  muted: boolean
  /** Latest peak level, 0 to 1. Updated with stats. */
  level: number
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

export interface AtemInput {
  id: number
  shortName: string
  longName: string
}

export interface AtemState {
  connected: boolean
  host: string
  model: string
  inputs: AtemInput[]
  program: number | null
  preview: number | null
  inTransition: boolean
}

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
  atem: AtemState
  data: Record<string, DataField>
  devices: { pairingOpen: boolean; pairingCode: string; controlUrl: string; list: PairedDevice[] }
  stats: HealthStats
}
