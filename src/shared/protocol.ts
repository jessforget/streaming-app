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
import type { AppState, AudioKind, HealthStats, InputDevice, LayerKind, Placement } from './state'

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
  /** Switch a phone camera to its front ('user') or back ('environment') camera. */
  'phone.facing': { device: string; facing: 'user' | 'environment' }
  /** Change a phone camera's settings: { exposure: 'manual', shutter: 200, iso: 400 }... (only what that phone allows). */
  'phone.camera': { device: string; set: Record<string, number | boolean | 'auto' | 'manual'> }
  'scene.program': { sceneId: string }
  'scene.goLive': Record<string, never>
  'transition.set': { kind: 'cut' | 'fade'; durationMs?: number }
  /** The manual fader: mix Live into Preview, 0 to 1. At 1, Preview goes on air (what was live goes to Preview). */
  'transition.mix': { level: number }
  'layer.setVisible': { sceneId: string; layerId: string; visible: boolean }
  /** The Overlay's ON AIR button: its sources on top of every scene, or off. Its sources use sceneId "overlay". */
  'overlay.set': { on: boolean }
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
  /** 'auto' = match the cameras; 'pal' = 25/50 fps; 'ntsc' = 30/60 fps. */
  'settings.setFrameRate': { frameRate: 'auto' | 'pal' | 'ntsc' }
  'settings.setDestination': {
    id: string
    enabled?: boolean
    serverUrl?: string
    streamKey?: string
  }
  /** Check a platform's saved stream key without going live. Answers { ok, message }. */
  'settings.testDestination': { id: string }
  'settings.setRecordFolder': { folder: string }
  // Editing scenes, sources and audio, like OBS. On-screen only, so a tap on a tablet can't break the layout.
  'scene.add': { name: string }
  'scene.remove': { sceneId: string }
  'scene.rename': { sceneId: string; name: string }
  /** Move a scene to a new place in the list (0 = first). */
  'scene.move': { sceneId: string; index: number }
  /** Put a scene away in the Scene library (stored: true), or bring it back into this show. */
  'scene.store': { sceneId: string; stored: boolean }
  /** Leave the Overlay off while this scene is on air. */
  'scene.setHideOverlay': { sceneId: string; hide: boolean }
  /** Link a Graphics (Overlay) source to a scene: it then shows only while that scene is in Live. on: false unlinks it. */
  'overlay.link': { layerId: string; sceneId: string; on: boolean }
  /**
   * A gfx app cued a commercial break (video files on this PC, played in order): fill the Gfx commercial
   * scene with them and put it in Preview. One video can be given as name and path.
   */
  'cue.commercial': { name?: string; path?: string; items?: { name: string; path: string }[]; extend?: boolean }
  /** The break's video (layerId) ended: show the next one in the Gfx commercial scene. */
  'cue.next': { layerId: string }
  /** The commercial break's sound: its level, mute, and what the mics do during a break. */
  'cue.sound': { volume?: number; muted?: boolean; mics?: 'off' | 'duck' | 'on' }
  /** Loop the commercial break (on), or let it end after this round (off). */
  'cue.loop': { on: boolean }
  /** The one sound for a scene: 'picture' (the sound with its camera), a channel's id, or null for none. */
  'scene.setSound': { sceneId: string; sourceId: string | null }
  /** Add a sound to a scene ('picture' or a channel's id), next to the ones it has. */
  'scene.addSound': { sceneId: string; sourceId: string }
  'scene.removeSound': { sceneId: string; sourceId: string }
  /** The gfx app took its cue back: empty the Commercial scene, and put back what was in Preview. */
  'cue.clear': Record<string, never>
  'layer.add': {
    sceneId: string
    kind: LayerKind
    name?: string
    device?: string
    text?: string
    url?: string
    placement?: Placement
    loop?: boolean
    /** Media that plays once: when it ends, go back to the scene that was live before. */
    returnAfter?: boolean
    sound?: boolean
    volume?: number
    color?: string
    until?: string
    minutes?: number
    seconds?: number
    /** Scene sources: which scene to show inside this one. */
    showScene?: string
    /** Graphics (network): the size its page is drawn at. */
    size?: '1080p' | '720p'
    /** Graphics (network): its frame rate; 0 = the same as the stream. */
    fps?: number
  }
  'layer.remove': { sceneId: string; layerId: string }
  'layer.move': { sceneId: string; layerId: string; direction: 'up' | 'down' }
  'layer.update': {
    sceneId: string
    layerId: string
    name?: string
    device?: string
    text?: string
    url?: string
    placement?: Placement
    loop?: boolean
    /** Media that plays once: when it ends, go back to the scene that was live before. */
    returnAfter?: boolean
    sound?: boolean
    volume?: number
    color?: string
    until?: string
    minutes?: number
    seconds?: number
    /** Scene sources: which scene to show inside this one. */
    showScene?: string
    /** Graphics (network): the size its page is drawn at. */
    size?: '1080p' | '720p'
    /** Graphics (network): its frame rate; 0 = the same as the stream. */
    fps?: number
  }
  'audio.add': {
    name: string
    kind: AudioKind
    device?: string
    channels?: number[]
    syncOffsetMs?: number
    /** Plays only while one of these scenes is on air. Absent or empty: every scene. */
    scenes?: string[]
    /** kind 'file': the music or sound file, and whether it loops (default yes). */
    url?: string
    loop?: boolean
  }
  'audio.update': {
    sourceId: string
    name?: string
    device?: string
    channels?: number[]
    syncOffsetMs?: number
    /** [] = every scene. */
    scenes?: string[]
    url?: string
    loop?: boolean
  }
  'inputs.report': { video: InputDevice[]; audio: InputDevice[] }
  'studio.report': { fps: number; audioLevels: Record<string, number> }
  /** The main window measured the cameras' frame rates. family null = no camera to go by. */
  'studio.cameraRate': { family: 'pal' | 'ntsc' | null; note: string }
  'audio.remove': { sourceId: string }
  'inputs.refresh': Record<string, never>
  /** Saved shows: { folder, shows: [{ file, name, savedAt, scenes }] }, newest first. */
  'show.list': Record<string, never>
  /** Save the show to its file; with a name, save a copy under that name (Save as). */
  'show.save': { name?: string }
  /** Open a saved show (not while streaming or recording). */
  'show.open': { file: string }
  /** Start a new show with a fresh layout. */
  'show.new': { name: string }
  'show.delete': { file: string }
  /** The show as a show file (to download and take to another PC). */
  'show.export': Record<string, never>
  /** Open a show file from another PC, and keep it in the shows folder. */
  'show.import': { show: unknown }
  /** Save the project by itself a moment after each change (on by default). */
  'show.setAutosave': { on: boolean }
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
  'phone.facing': 'operate',
  'phone.camera': 'operate',
  'scene.program': 'operate',
  'scene.goLive': 'operate',
  'transition.set': 'operate',
  'transition.mix': 'operate',
  'layer.setVisible': 'operate',
  'overlay.set': 'operate',
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
  'settings.setFrameRate': 'admin',
  'settings.setDestination': 'admin',
  'settings.testDestination': 'admin',
  'settings.setRecordFolder': 'admin',
  'scene.add': 'admin',
  'scene.remove': 'admin',
  'scene.rename': 'admin',
  'scene.move': 'admin',
  'scene.store': 'admin',
  'scene.setHideOverlay': 'admin',
  'overlay.link': 'admin',
  'cue.commercial': 'admin',
  'cue.clear': 'admin',
  'cue.next': 'admin',
  'cue.sound': 'operate',
  'cue.loop': 'operate',
  'scene.setSound': 'admin',
  'scene.addSound': 'admin',
  'scene.removeSound': 'admin',
  'layer.add': 'admin',
  'layer.remove': 'admin',
  'layer.move': 'admin',
  'layer.update': 'admin',
  'audio.add': 'admin',
  'audio.update': 'admin',
  'inputs.report': 'admin',
  'studio.report': 'admin',
  'studio.cameraRate': 'admin',
  'audio.remove': 'admin',
  'inputs.refresh': 'admin',
  'show.list': 'admin',
  'show.save': 'admin',
  'show.open': 'admin',
  'show.new': 'admin',
  'show.delete': 'admin',
  'show.export': 'admin',
  'show.import': 'admin',
  'show.setAutosave': 'admin',
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
  role: Role | 'local'
  state: AppState
  /** Only for the main window on the streaming PC: true when this page runs the video (the studio). */
  studio?: boolean
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

/** Something went wrong on its own (a stream dropped, a device was unplugged), in plain words. */
export interface NoticeEvent {
  type: 'event'
  name: 'notice'
  message: string
}

export interface ErrorMessage {
  type: 'error'
  error: string
}

/** Main window only: a phone wants to send its camera (WebRTC offer). Answer with a "phone-answer" message. */
export interface PhoneOfferMessage {
  type: 'phone-offer'
  reqId: string
  /** The phone's own id; the camera shows in the device list as "phone:<id>". */
  id: string
  name: string
  sdp: string
}

export type ServerMessage =
  | PhoneOfferMessage
  | PairedMessage
  | WelcomeMessage
  | ResultMessage
  | StateEvent
  | StatsEvent
  | NoticeEvent
  | ErrorMessage

export class CommandError extends Error {}
