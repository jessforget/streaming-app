/**
 * Control protocol, version 1.
 *
 * Every device on the local network (tablet remote, companion app, a future
 * stream deck) talks to the streaming app with these JSON messages over one
 * WebSocket. The on-screen interface uses the same commands, so anything a
 * button can do, a paired device can do too (if its role allows it).
 *
 * See docs/PROTOCOL.md for the human-readable version.
 */
import type { AppState, AudioKind, HealthStats, LayerKind } from './state'

export const PROTOCOL_VERSION = 1
export const DEFAULT_CONTROL_PORT = 7420

/** What a paired device is allowed to do. */
export type Role = 'remote' | 'buttons' | 'data' | 'viewer'

/** The local on-screen interface. Never handed to a network device. */
export type Caller = Role | 'local'

export const ROLES: Role[] = ['remote', 'buttons', 'data', 'viewer']

export const ROLE_LABELS: Record<Role, string> = {
  remote: 'Remote (full control)',
  buttons: 'Buttons (press, no settings)',
  data: 'Data (update data fields only)',
  viewer: 'Viewer (status only)'
}

export type DataValue = string | number | boolean | null

/** All commands and the parameters each one takes. */
export interface CommandMap {
  'state.get': Record<string, never>
  'scene.preview': { sceneId: string }
  'scene.program': { sceneId: string }
  'scene.goLive': Record<string, never>
  'transition.set': { kind: 'cut' | 'fade'; durationMs?: number }
  'layer.setVisible': { sceneId: string; layerId: string; visible: boolean }
  'audio.setVolume': { sourceId: string; volume: number }
  'audio.setMuted': { sourceId: string; muted: boolean }
  'audio.muteAll': Record<string, never>
  'stream.start': Record<string, never>
  'stream.stop': Record<string, never>
  'record.start': Record<string, never>
  'record.stop': Record<string, never>
  'data.set': { values: Record<string, DataValue> }
  'data.clear': { keys?: string[] }
  // Settings: only the on-screen interface may call these.
  'settings.setQuality': { quality: 'low' | 'medium' | 'high' }
  'settings.setDestination': {
    id: string
    enabled?: boolean
    serverUrl?: string
    streamKey?: string
  }
  'settings.setRecordFolder': { folder: string }
  // Editing scenes, sources and audio, like OBS. On-screen only, so a tap on a tablet can't break the layout.
  'scene.add': { name: string }
  'scene.remove': { sceneId: string }
  'scene.rename': { sceneId: string; name: string }
  'layer.add': {
    sceneId: string
    kind: LayerKind
    name?: string
    device?: string
    text?: string
    url?: string
  }
  'layer.remove': { sceneId: string; layerId: string }
  'layer.move': { sceneId: string; layerId: string; direction: 'up' | 'down' }
  'layer.update': { sceneId: string; layerId: string; name?: string; device?: string; text?: string; url?: string }
  'audio.add': { name: string; kind: AudioKind; device?: string }
  'audio.remove': { sourceId: string }
  'inputs.refresh': Record<string, never>
  'devices.setPairingOpen': { open: boolean }
  'devices.newPairingCode': Record<string, never>
  'devices.remove': { deviceId: string }
  'devices.setRole': { deviceId: string; role: Role }
}

export type Action = keyof CommandMap

type Permission = 'read' | 'operate' | 'data' | 'admin'

/** Which permission each command needs. */
export const ACTION_PERMISSION: Record<Action, Permission> = {
  'state.get': 'read',
  'scene.preview': 'operate',
  'scene.program': 'operate',
  'scene.goLive': 'operate',
  'transition.set': 'operate',
  'layer.setVisible': 'operate',
  'audio.setVolume': 'operate',
  'audio.setMuted': 'operate',
  'audio.muteAll': 'operate',
  'stream.start': 'operate',
  'stream.stop': 'operate',
  'record.start': 'operate',
  'record.stop': 'operate',
  'data.set': 'data',
  'data.clear': 'data',
  'settings.setQuality': 'admin',
  'settings.setDestination': 'admin',
  'settings.setRecordFolder': 'admin',
  'scene.add': 'admin',
  'scene.remove': 'admin',
  'scene.rename': 'admin',
  'layer.add': 'admin',
  'layer.remove': 'admin',
  'layer.move': 'admin',
  'layer.update': 'admin',
  'audio.add': 'admin',
  'audio.remove': 'admin',
  'inputs.refresh': 'admin',
  'devices.setPairingOpen': 'admin',
  'devices.newPairingCode': 'admin',
  'devices.remove': 'admin',
  'devices.setRole': 'admin'
}

const ROLE_PERMISSIONS: Record<Caller, Permission[]> = {
  local: ['read', 'operate', 'data', 'admin'],
  remote: ['read', 'operate', 'data'],
  buttons: ['read', 'operate'],
  data: ['read', 'data'],
  viewer: ['read']
}

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACTION_PERMISSION, value)
}

export function canRun(caller: Caller, action: Action): boolean {
  return ROLE_PERMISSIONS[caller].includes(ACTION_PERMISSION[action])
}

// ---------- Messages a device sends ----------

export interface PairMessage {
  type: 'pair'
  code: string
  name: string
  /** The role the device asks for. The app owner can change it later. */
  role?: Role
}

export interface HelloMessage {
  type: 'hello'
  token: string
}

export interface CommandMessage<A extends Action = Action> {
  type: 'command'
  id?: string
  action: A
  params?: CommandMap[A]
}

/** Shortcut for the companion app: same as command data.set. */
export interface DataMessage {
  type: 'data'
  id?: string
  set: Record<string, DataValue>
}

export type ClientMessage = PairMessage | HelloMessage | CommandMessage | DataMessage

// ---------- Messages the app sends ----------

export interface PairedMessage {
  type: 'paired'
  v: number
  deviceId: string
  token: string
  role: Role
}

export interface WelcomeMessage {
  type: 'welcome'
  v: number
  deviceId: string
  name: string
  role: Role
  state: AppState
}

export interface ResultMessage {
  type: 'result'
  id?: string
  ok: boolean
  error?: string
  data?: unknown
}

export interface StateEvent {
  type: 'event'
  name: 'state'
  state: AppState
}

export interface StatsEvent {
  type: 'event'
  name: 'stats'
  stats: HealthStats
}

export interface ErrorMessage {
  type: 'error'
  error: string
}

export type ServerMessage =
  | PairedMessage
  | WelcomeMessage
  | ResultMessage
  | StateEvent
  | StatsEvent
  | ErrorMessage

export class CommandError extends Error {}
