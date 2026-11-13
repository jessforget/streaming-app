/**
 * The controller owns the app's state and runs every command, whoever sends
 * it: the on-screen interface, the tablet remote, the companion app or a
 * stream deck. It checks permissions, drives the engine and the ATEM, and
 * announces each change.
 */
import {
  ACTION_PERMISSION,
  CommandError,
  ROLES,
  canRun,
  isAction,
  type Action,
  type Caller,
  type CommandMap,
  type DataValue,
  type Role
} from '../shared/protocol'
import type { AppState, Health, HealthStats, Layer, Scene } from '../shared/state'
import { MAX_DESTINATIONS, PLATFORMS, QUALITY_PRESETS, requiredUploadKbps } from '../shared/presets'
import { isValidFieldName, renderTemplate, templateFields } from '../shared/template'
import { Emitter } from './emitter'
import { IDLE_STATS } from './defaults'
import type { AtemLink, DeviceAdmin, Engine, KeyStore, StreamTarget } from './ports'

export interface ControllerOptions {
  engine: Engine
  atem: AtemLink
  keys: KeyStore
  initial: AppState
  devices?: DeviceAdmin
  now?: () => number
}

type Events = { state: AppState; stats: HealthStats; error: string }

const MAX_DATA_FIELDS = 500
const MAX_DATA_VALUE_LENGTH = 2000

export class Controller extends Emitter<Events> {
  private s: AppState
  private readonly engine: Engine
  private readonly atem: AtemLink
  private readonly keys: KeyStore
  private devices?: DeviceAdmin
  private readonly now: () => number
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private lastDropped = 0
  private lastTotal = 0

  constructor(opts: ControllerOptions) {
    super()
    this.engine = opts.engine
    this.atem = opts.atem
    this.keys = opts.keys
    this.devices = opts.devices
    this.now = opts.now ?? (() => Date.now())
    this.s = structuredClone(opts.initial)
    for (const d of this.s.stream.destinations) d.hasKey = this.keys.has(d.id)
    this.atem.onChange((snap) => {
      this.s.atem = { ...snap, host: this.s.atem.host }
      this.changed()
    })
  }

  get state(): AppState {
    return this.s
  }

  setDeviceAdmin(devices: DeviceAdmin) {
    this.devices = devices
  }

  /** The pairing manager reports paired devices and the pairing code here. */
  updateDevices(devices: Partial<AppState['devices']>) {
    this.s.devices = { ...this.s.devices, ...devices }
    this.changed()
  }

  async start(options: { statsIntervalMs?: number } = {}) {
    await this.engine.init(this.s)
    await this.refreshAllTexts()
    if (this.s.atem.host) this.connectAtem(this.s.atem.host)
    const ms = options.statsIntervalMs ?? 1000
    if (ms > 0) this.statsTimer = setInterval(() => this.tickStats(), ms)
  }

  async stop() {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    await this.atem.disconnect().catch(() => {})
    await this.engine.shutdown()
  }

  /**
   * Run a command. `source` names the sender (shown next to data fields).
   * Throws CommandError with a plain-words message when it can't be done.
   */
  async run(caller: Caller, action: unknown, params: unknown = {}, source = 'This PC'): Promise<unknown> {
    if (!isAction(action)) throw new CommandError(`Unknown command: ${String(action)}`)
    if (!canRun(caller, action)) {
      throw new CommandError(`Not allowed: "${action}" needs ${ACTION_PERMISSION[action]} permission`)
    }
    const p = (params ?? {}) as Record<string, unknown>
    if (typeof p !== 'object' || Array.isArray(p)) throw new CommandError('params must be an object')
    return this.dispatch(action, p as never, source)
  }

  private async dispatch<A extends Action>(action: A, p: CommandMap[A], source: string): Promise<unknown> {
    const P = p as Record<string, unknown>
    switch (action) {
      case 'state.get':
        return this.s

      case 'scene.preview': {
        const scene = this.scene(str(P, 'sceneId'))
        this.s.previewSceneId = scene.id
        await this.engine.setPreviewScene(scene.id)
        return this.changed()
      }
      case 'scene.program': {
        await this.takeLive(this.scene(str(P, 'sceneId')))
        return this.changed()
      }
      case 'scene.goLive': {
        const next = this.scene(this.s.previewSceneId)
        const previous = this.s.programSceneId
        await this.takeLive(next)
        // Like a vision mixer: what was live goes back to preview.
        this.s.previewSceneId = previous
        await this.engine.setPreviewScene(previous)
        return this.changed()
      }
      case 'transition.set': {
        const kind = P.kind
        if (kind !== 'cut' && kind !== 'fade') throw new CommandError('kind must be "cut" or "fade"')
        const durationMs = P.durationMs === undefined ? this.s.transition.durationMs : num(P, 'durationMs', 0, 5000)
        this.s.transition = { kind, durationMs }
        return this.changed()
      }
      case 'layer.setVisible': {
        const scene = this.scene(str(P, 'sceneId'))
        const layer = this.layer(scene, str(P, 'layerId'))
        layer.visible = bool(P, 'visible')
        await this.engine.setLayerVisible(scene.id, layer.id, layer.visible)
        return this.changed()
      }

      case 'audio.setVolume': {
        const src = this.audio(str(P, 'sourceId'))
        src.volume = num(P, 'volume', 0, 1)
        await this.engine.setVolume(src.id, src.volume)
        return this.changed()
      }
      case 'audio.setMuted': {
        const src = this.audio(str(P, 'sourceId'))
        src.muted = bool(P, 'muted')
        await this.engine.setMuted(src.id, src.muted)
        return this.changed()
      }
      case 'audio.muteAll': {
        for (const src of this.s.audio) {
          src.muted = true
          await this.engine.setMuted(src.id, true)
        }
        return this.changed()
      }

      case 'stream.start':
        return this.startStream()
      case 'stream.stop': {
        if (!this.s.stream.live) return this.s
        await this.engine.stopStream()
        this.s.stream.live = false
        this.s.stream.startedAt = null
        this.resetStatsIfIdle()
        return this.changed()
      }
      case 'record.start': {
        if (this.s.recording.active) return this.s
        const r = this.s.recording
        await this.engine.startRecording(r.folder, r.format, QUALITY_PRESETS[this.s.stream.quality])
        r.active = true
        r.startedAt = this.now()
        return this.changed()
      }
      case 'record.stop': {
        if (!this.s.recording.active) return this.s
        await this.engine.stopRecording()
        this.s.recording.active = false
        this.s.recording.startedAt = null
        this.resetStatsIfIdle()
        return this.changed()
      }

      case 'atem.preview':
        this.requireAtem()
        await this.atem.setPreview(this.atemInput(P))
        return null
      case 'atem.program':
        this.requireAtem()
        await this.atem.setProgram(this.atemInput(P))
        return null
      case 'atem.cut':
        this.requireAtem()
        await this.atem.cut()
        return null
      case 'atem.auto':
        this.requireAtem()
        // Don't wait: an auto transition takes a while and the caller only needs to know it started.
        this.atem.auto().catch((e) => this.emit('error', `ATEM: ${errorText(e)}`))
        return null

      case 'data.set':
        return this.setData(P.values, source)
      case 'data.clear': {
        const keys = P.keys
        if (keys === undefined) this.s.data = {}
        else if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) {
          for (const k of keys) delete this.s.data[k]
        } else throw new CommandError('keys must be a list of field names')
        await this.refreshAllTexts()
        return this.changed()
      }

      case 'settings.setQuality': {
        const q = P.quality
        if (q !== 'low' && q !== 'medium' && q !== 'high') throw new CommandError('quality must be low, medium or high')
        if (this.s.stream.live || this.s.recording.active) throw new CommandError('Stop streaming and recording first')
        this.s.stream.quality = q
        return this.changed()
      }
      case 'settings.setDestination':
        return this.setDestination(P)
      case 'settings.setRecordFolder': {
        if (this.s.recording.active) throw new CommandError('Stop recording first')
        this.s.recording.folder = str(P, 'folder')
        return this.changed()
      }
      case 'settings.setAtemHost': {
        const host = typeof P.host === 'string' ? P.host.trim() : ''
        this.s.atem.host = host
        await this.atem.disconnect().catch(() => {})
        if (host) this.connectAtem(host)
        return this.changed()
      }

      case 'devices.setPairingOpen':
        this.deviceAdmin().setPairingOpen(bool(P, 'open'))
        return null
      case 'devices.newPairingCode':
        this.deviceAdmin().newPairingCode()
        return null
      case 'devices.remove':
        this.deviceAdmin().remove(str(P, 'deviceId'))
        return null
      case 'devices.setRole': {
        const role = P.role as Role
        if (!ROLES.includes(role)) throw new CommandError(`role must be one of ${ROLES.join(', ')}`)
        this.deviceAdmin().setRole(str(P, 'deviceId'), role)
        return null
      }
    }
    throw new CommandError(`Unhandled command: ${action}`)
  }

  // ---------- Streaming ----------

  private async startStream() {
    if (this.s.stream.live) return this.s
    const enabled = this.s.stream.destinations.filter((d) => d.enabled)
    if (enabled.length === 0) throw new CommandError('Turn on at least one platform in Go Live settings')
    if (enabled.length > MAX_DESTINATIONS) {
      throw new CommandError(`You can stream to at most ${MAX_DESTINATIONS} platforms at once`)
    }
    const targets: StreamTarget[] = []
    for (const d of enabled) {
      const info = PLATFORMS[d.platform]
      const key = this.keys.get(d.id)
      if (!key) throw new CommandError(`Add your ${info.label} stream key in Go Live settings`)
      const url = info.needsServerUrl ? d.serverUrl : info.ingestUrl
      if (!url) throw new CommandError(`Add the ${info.label} server address in Go Live settings`)
      targets.push({ destinationId: d.id, platform: d.platform, url, key, vertical: d.vertical })
    }
    await this.engine.startStream(targets, QUALITY_PRESETS[this.s.stream.quality])
    this.s.stream.live = true
    this.s.stream.startedAt = this.now()
    return this.changed()
  }

  private setDestination(P: Record<string, unknown>) {
    const id = str(P, 'id')
    const d = this.s.stream.destinations.find((x) => x.id === id)
    if (!d) throw new CommandError(`No platform with id ${id}`)
    if (this.s.stream.live) throw new CommandError('Stop the stream before changing platforms')
    if (P.enabled !== undefined) {
      const on = bool(P, 'enabled')
      const count = this.s.stream.destinations.filter((x) => x.enabled && x.id !== id).length
      if (on && count >= MAX_DESTINATIONS) {
        throw new CommandError(`You can stream to at most ${MAX_DESTINATIONS} platforms at once`)
      }
      d.enabled = on
    }
    if (P.serverUrl !== undefined) {
      const url = String(P.serverUrl).trim()
      if (url && !/^rtmps?:\/\//i.test(url)) throw new CommandError('Server address must start with rtmp:// or rtmps://')
      d.serverUrl = url || undefined
    }
    if (P.streamKey !== undefined) {
      this.keys.set(d.id, String(P.streamKey).trim())
      d.hasKey = this.keys.has(d.id)
    }
    return this.changed()
  }

  // ---------- Scenes ----------

  private async takeLive(scene: Scene) {
    this.s.programSceneId = scene.id
    await this.engine.setProgramScene(scene.id, this.s.transition)
    if (scene.atemInput !== undefined && this.s.atem.connected) {
      await this.atem.setProgram(scene.atemInput).catch((e) => this.emit('error', `ATEM: ${errorText(e)}`))
    }
  }

  // ---------- Data fields ----------

  private async setData(values: unknown, source: string) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new CommandError('values must be an object like {"team1.score": 3}')
    }
    const entries = Object.entries(values as Record<string, unknown>)
    for (const [key, value] of entries) {
      if (!isValidFieldName(key)) throw new CommandError(`Bad field name "${key}": use letters, digits, dot, dash or underscore`)
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new CommandError(`Field "${key}" must be text, a number, true/false or null`)
      }
      if (typeof value === 'string' && value.length > MAX_DATA_VALUE_LENGTH) {
        throw new CommandError(`Field "${key}" is longer than ${MAX_DATA_VALUE_LENGTH} characters`)
      }
    }
    const newKeys = entries.filter(([k]) => !(k in this.s.data)).length
    if (Object.keys(this.s.data).length + newKeys > MAX_DATA_FIELDS) {
      throw new CommandError(`Too many data fields (limit ${MAX_DATA_FIELDS})`)
    }
    const at = this.now()
    for (const [key, value] of entries) {
      this.s.data[key] = { value: value as DataValue, updatedAt: at, source }
    }
    await this.refreshTexts(new Set(entries.map(([k]) => k)))
    return this.changed()
  }

  /** Re-render text layers that use any of the changed fields. */
  private async refreshTexts(changed: Set<string>) {
    for (const scene of this.s.scenes) {
      for (const layer of scene.layers) {
        if (layer.kind !== 'text' || !layer.text) continue
        if (templateFields(layer.text).some((f) => changed.has(f))) await this.pushText(scene, layer)
      }
    }
  }

  private async refreshAllTexts() {
    for (const scene of this.s.scenes) {
      for (const layer of scene.layers) if (layer.kind === 'text' && layer.text) await this.pushText(scene, layer)
    }
  }

  private pushText(scene: Scene, layer: Layer) {
    return this.engine.setLayerText(scene.id, layer.id, renderTemplate(layer.text ?? '', this.s.data))
  }

  // ---------- Health ----------

  /** Called once a second. Turns engine numbers into the plain-words health bar. */
  tickStats() {
    const raw = this.engine.readStats()
    for (const src of this.s.audio) src.level = raw.audioLevels[src.id] ?? 0
    const active = this.s.stream.live || this.s.recording.active
    const enabled = this.s.stream.destinations.filter((d) => d.enabled).length
    const requiredKbps = requiredUploadKbps(this.s.stream.quality, enabled)
    const newFrames = raw.totalFrames - this.lastTotal
    const newDropped = raw.droppedFrames - this.lastDropped
    this.lastTotal = raw.totalFrames
    this.lastDropped = raw.droppedFrames
    const dropPct = newFrames > 0 ? (newDropped / newFrames) * 100 : 0

    let health: Health = 'idle'
    let message = 'Ready'
    if (active) {
      health = 'good'
      message = `Healthy, ${raw.droppedFrames} dropped frames`
      if (dropPct > 5) {
        health = 'bad'
        message = `Your upload can't keep up (${Math.round(requiredKbps / 1000)} Mbps needed). Try a lower quality or fewer platforms.`
      } else if (dropPct > 1) {
        health = 'warning'
        message = 'Some frames are being dropped. Your upload is close to its limit.'
      } else if (raw.cpu > 85) {
        health = 'warning'
        message = 'Your computer is working hard. Close other apps or pick a lower quality.'
      }
    }
    this.s.stats = {
      health,
      message,
      fps: raw.fps,
      cpu: raw.cpu,
      droppedFrames: raw.droppedFrames,
      totalFrames: raw.totalFrames,
      requiredKbps,
      audioLevels: raw.audioLevels
    }
    this.emit('stats', this.s.stats)
  }

  private resetStatsIfIdle() {
    if (!this.s.stream.live && !this.s.recording.active) this.s.stats = { ...IDLE_STATS, audioLevels: this.s.stats.audioLevels }
  }

  // ---------- Helpers ----------

  private connectAtem(host: string) {
    this.atem.connect(host).catch((e) => this.emit('error', `Could not reach the ATEM at ${host}: ${errorText(e)}`))
  }

  private changed(): AppState {
    this.emit('state', this.s)
    return this.s
  }

  private scene(id: string): Scene {
    const scene = this.s.scenes.find((x) => x.id === id)
    if (!scene) throw new CommandError(`No scene with id ${id}`)
    return scene
  }

  private layer(scene: Scene, id: string): Layer {
    const layer = scene.layers.find((x) => x.id === id)
    if (!layer) throw new CommandError(`No layer with id ${id} in ${scene.name}`)
    return layer
  }

  private audio(id: string) {
    const src = this.s.audio.find((x) => x.id === id)
    if (!src) throw new CommandError(`No audio source with id ${id}`)
    return src
  }

  private requireAtem() {
    if (!this.s.atem.connected) throw new CommandError('The ATEM is not connected')
  }

  private atemInput(P: Record<string, unknown>): number {
    const input = num(P, 'input', 0, 65535)
    if (!this.s.atem.inputs.some((i) => i.id === input)) throw new CommandError(`The ATEM has no input ${input}`)
    return input
  }

  private deviceAdmin(): DeviceAdmin {
    if (!this.devices) throw new CommandError('Device pairing is not available')
    return this.devices
  }
}

function str(P: Record<string, unknown>, key: string): string {
  const v = P[key]
  if (typeof v !== 'string' || v === '') throw new CommandError(`${key} must be text`)
  return v
}

function num(P: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = P[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new CommandError(`${key} must be a number from ${min} to ${max}`)
  }
  return v
}

function bool(P: Record<string, unknown>, key: string): boolean {
  const v = P[key]
  if (typeof v !== 'boolean') throw new CommandError(`${key} must be true or false`)
  return v
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
