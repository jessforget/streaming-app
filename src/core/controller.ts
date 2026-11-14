/**
 * The controller owns the app's state and runs every command, whoever sends
 * it: the on-screen interface, the tablet remote, the companion app or a
 * stream deck. It checks permissions, drives the engine, and announces each
 * change. Camera switching is not here: the ATEM does that, and this app
 * takes its output in as a source, like OBS.
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
import { LAYER_KINDS, PLACEMENTS, SYNC_OFFSET_RANGE, type InputDevice, type Placement, channelCount, type AppState, type AudioKind, type Health, type HealthStats, type Layer, type LayerKind, type Scene } from '../shared/state'
import { MAX_DESTINATIONS, PLATFORMS, QUALITY_PRESETS, requiredUploadKbps } from '../shared/presets'
import { isValidFieldName, renderTemplate, templateFields } from '../shared/template'
import { Emitter } from './emitter'
import { IDLE_STATS } from './defaults'
import type { DeviceAdmin, Engine, KeyStore, StreamTarget } from './ports'

export interface ControllerOptions {
  engine: Engine
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
  private readonly keys: KeyStore
  private devices?: DeviceAdmin
  private readonly now: () => number
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private deviceTimer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private lastDropped = 0
  private lastTotal = 0

  constructor(opts: ControllerOptions) {
    super()
    this.engine = opts.engine
    this.keys = opts.keys
    this.devices = opts.devices
    this.now = opts.now ?? (() => Date.now())
    this.s = structuredClone(opts.initial)
    for (const d of this.s.stream.destinations) d.hasKey = this.keys.has(d.id)
    // The engine says when an output stops on its own (connection lost, the studio page closed).
    this.engine.onOutputStopped = (kind, reason) => {
      if (kind === 'stream' && this.s.stream.live) {
        this.s.stream.live = false
        this.s.stream.startedAt = null
      } else if (kind === 'record' && this.s.recording.active) {
        this.s.recording.active = false
        this.s.recording.startedAt = null
      } else return
      this.emit('error', reason)
      this.changed()
    }
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

  /**
   * `devicePollMs`: how often to look for capture and audio devices being
   * plugged in or unplugged (0 = never, as in tests).
   */
  async start(options: { statsIntervalMs?: number; devicePollMs?: number } = {}) {
    await this.engine.init(this.s)
    await this.refreshAllTexts()
    await this.refreshInputs()
    const ms = options.statsIntervalMs ?? 1000
    if (ms > 0) this.statsTimer = setInterval(() => this.tickStats(), ms)
    const poll = options.devicePollMs ?? 3000
    if (poll > 0) this.deviceTimer = setInterval(() => void this.pollDevices(), poll)
  }

  async stop() {
    if (this.statsTimer) clearInterval(this.statsTimer)
    if (this.deviceTimer) clearInterval(this.deviceTimer)
    this.statsTimer = null
    this.deviceTimer = null
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

      case 'scene.add': {
        const scene: Scene = { id: this.newId('scene'), name: name(P, 'name'), layers: [] }
        this.s.scenes.push(scene)
        await this.engine.setScene(scene)
        this.changed()
        return { sceneId: scene.id }
      }
      case 'scene.remove': {
        const scene = this.scene(str(P, 'sceneId'))
        if (this.s.scenes.length === 1) throw new CommandError('Keep at least one scene')
        if (scene.id === this.s.programSceneId) throw new CommandError('That scene is on air. Put another scene live first.')
        this.s.scenes = this.s.scenes.filter((x) => x !== scene)
        if (this.s.previewSceneId === scene.id) this.s.previewSceneId = this.s.programSceneId
        await this.engine.removeScene(scene.id)
        return this.changed()
      }
      case 'scene.rename': {
        this.scene(str(P, 'sceneId')).name = name(P, 'name')
        return this.changed()
      }
      case 'layer.add': {
        const scene = this.scene(str(P, 'sceneId'))
        const kind = P.kind as LayerKind
        if (!LAYER_KINDS.includes(kind)) throw new CommandError(`kind must be one of ${LAYER_KINDS.join(', ')}`)
        const layer: Layer = { id: this.newId('layer'), name: '', kind, visible: true }
        this.applyLayerFields(layer, P)
        if (!layer.name) layer.name = this.defaultLayerName(layer)
        scene.layers.unshift(layer) // new sources go on top, like OBS
        await this.engine.setScene(scene)
        if (layer.kind === 'text') await this.pushText(scene, layer)
        this.changed()
        return { layerId: layer.id }
      }
      case 'layer.remove': {
        const scene = this.scene(str(P, 'sceneId'))
        const layer = this.layer(scene, str(P, 'layerId'))
        scene.layers = scene.layers.filter((x) => x !== layer)
        await this.engine.setScene(scene)
        return this.changed()
      }
      case 'layer.move': {
        const scene = this.scene(str(P, 'sceneId'))
        const layer = this.layer(scene, str(P, 'layerId'))
        const dir = P.direction
        if (dir !== 'up' && dir !== 'down') throw new CommandError('direction must be "up" or "down"')
        const i = scene.layers.indexOf(layer)
        const j = dir === 'up' ? i - 1 : i + 1
        if (j < 0 || j >= scene.layers.length) return this.s
        scene.layers.splice(i, 1)
        scene.layers.splice(j, 0, layer)
        await this.engine.setScene(scene)
        return this.changed()
      }
      case 'layer.update': {
        const scene = this.scene(str(P, 'sceneId'))
        const layer = this.layer(scene, str(P, 'layerId'))
        this.applyLayerFields(layer, P)
        await this.engine.setScene(scene)
        if (layer.kind === 'text') await this.pushText(scene, layer)
        return this.changed()
      }
      case 'audio.add': {
        const kind = P.kind as AudioKind
        if (!['device', 'desktop', 'video'].includes(kind)) throw new CommandError('kind must be device, desktop or video')
        const device = kind === 'desktop' ? undefined : this.device(kind === 'video' ? 'video' : 'audio', P.device)
        const id = this.newId('audio')
        const channels = kind === 'desktop' ? undefined : this.channels(kind, device, P.channels)
        const syncOffsetMs = P.syncOffsetMs === undefined ? 0 : syncOffset(P)
        this.s.audio.push({ id, name: name(P, 'name'), kind, device, channels, syncOffsetMs, volume: 0.8, muted: false, level: 0 })
        await this.engine.setAudioSources(this.s.audio)
        this.changed()
        return { sourceId: id }
      }
      case 'audio.update': {
        const src = this.audio(str(P, 'sourceId'))
        if (P.name !== undefined) src.name = name(P, 'name')
        if (P.device !== undefined) {
          if (src.kind === 'desktop') throw new CommandError('Desktop sound has no device to pick')
          const device = this.device(src.kind === 'video' ? 'video' : 'audio', P.device)
          // Another device has other channels: start again from its first pair.
          if (device !== src.device) src.channels = undefined
          src.device = device
        }
        if (P.channels !== undefined) {
          if (src.kind === 'desktop') throw new CommandError('Desktop sound has no channels to pick')
          src.channels = this.channels(src.kind, src.device, P.channels)
        }
        if (P.syncOffsetMs !== undefined) src.syncOffsetMs = syncOffset(P)
        await this.engine.setAudioSources(this.s.audio)
        return this.changed()
      }
      case 'audio.remove': {
        const src = this.audio(str(P, 'sourceId'))
        this.s.audio = this.s.audio.filter((x) => x !== src)
        await this.engine.setAudioSources(this.s.audio)
        return this.changed()
      }
      case 'inputs.report': {
        // The main window's browser lists the devices it can open, with their real names.
        const list = (v: unknown, kind: string) => {
          if (!Array.isArray(v) || v.length > 64) throw new CommandError(`${kind} must be a list of devices`)
          return v.map((d) => {
            if (!d || typeof d.id !== 'string' || typeof d.name !== 'string' || !d.id || d.id.length > 256) {
              throw new CommandError('Each device needs an id and a name')
            }
            const out: InputDevice = { id: d.id, name: d.name.slice(0, 120) || 'Unnamed device' }
            if (d.driver === 'wasapi' || d.driver === 'asio') out.driver = d.driver
            if (typeof d.group === 'string') out.group = d.group.slice(0, 256)
            if (Number.isInteger(d.channels) && d.channels >= 1 && d.channels <= 64) out.channels = d.channels
            if (Array.isArray(d.channelNames)) out.channelNames = d.channelNames.slice(0, 64).map((n: unknown) => String(n).slice(0, 60))
            return out
          })
        }
        const inputs = { video: list(P.video, 'video'), audio: list(P.audio, 'audio') }
        this.engine.setInputs?.(inputs)
        await this.applyInputs(inputs)
        return null
      }
      case 'studio.report': {
        const levels: Record<string, number> = {}
        const raw = P.audioLevels
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && v >= 0 && v <= 1) levels[k] = v
        }
        this.engine.report?.({ fps: typeof P.fps === 'number' ? P.fps : 0, audioLevels: levels })
        return null
      }
      case 'inputs.refresh':
        await this.refreshInputs()
        return this.changed()

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

  private async refreshInputs() {
    try {
      this.s.inputs = await this.engine.listDevices()
    } catch (e) {
      this.emit('error', `Could not list capture devices: ${errorText(e)}`)
    }
  }

  /** Look for devices plugged in or unplugged; say so in plain words when one in use goes or comes back. */
  async pollDevices() {
    if (this.polling) return
    this.polling = true
    try {
      let now: AppState['inputs']
      try {
        now = await this.engine.listDevices()
      } catch {
        return
      }
      await this.applyInputs(now)
    } finally {
      this.polling = false
    }
  }

  /** New list of devices the PC can see; say so in plain words when one in use goes or comes back. */
  private async applyInputs(now: AppState['inputs']) {
    {
      const before = this.s.inputs
      if (JSON.stringify(now) === JSON.stringify(before)) return
      this.s.inputs = now
      this.findMovedDevices(before, now)
      const ids = (x: AppState['inputs']) => new Set([...x.video, ...x.audio].map((d) => d.id))
      const was = ids(before)
      const is = ids(now)
      const used = new Set([
        ...this.s.audio.map((a) => a.device),
        ...this.s.scenes.flatMap((s) => s.layers.map((l) => l.device))
      ])
      const named = (id: string) => [...before.video, ...before.audio, ...now.video, ...now.audio].find((d) => d.id === id)?.name ?? id
      for (const id of was) if (!is.has(id) && used.has(id)) this.emit('error', `${named(id)} was unplugged`)
      const back = [...is].filter((id) => !was.has(id) && used.has(id))
      if (back.length) {
        // Reopen what uses it, so sound and picture come back without a restart.
        await this.engine.setAudioSources(this.s.audio)
        for (const scene of this.s.scenes) if (scene.layers.some((l) => l.device && back.includes(l.device))) await this.engine.setScene(scene)
      }
      this.changed()
    }
  }

  /**
   * Browsers give a device a new id now and then (after clearing site data,
   * or in a new browser profile). A device in use that vanished while one
   * with the same name and kind appeared is the same device: follow it.
   */
  private findMovedDevices(before: AppState['inputs'], now: AppState['inputs']) {
    for (const kind of ['video', 'audio'] as const) {
      const nowIds = new Set(now[kind].map((d) => d.id))
      for (const old of before[kind]) {
        if (nowIds.has(old.id)) continue
        const twins = now[kind].filter((d) => d.name === old.name && !before[kind].some((b) => b.id === d.id))
        if (twins.length !== 1) continue
        const id = twins[0].id
        for (const a of this.s.audio) if (a.device === old.id) a.device = id
        for (const scene of this.s.scenes) for (const l of scene.layers) if (l.device === old.id) l.device = id
      }
    }
  }

  private applyLayerFields(layer: Layer, P: Record<string, unknown>) {
    if (P.name !== undefined) layer.name = name(P, 'name')
    if (P.device !== undefined) {
      if (layer.kind !== 'video') throw new CommandError('Only video sources have a device')
      layer.device = this.device('video', P.device)
    }
    if (P.text !== undefined) {
      if (typeof P.text !== 'string' || P.text.length > 500) throw new CommandError('text must be up to 500 characters')
      layer.text = P.text
    }
    if (P.url !== undefined) {
      if (typeof P.url !== 'string' || P.url.length > 2000) throw new CommandError('url must be text')
      layer.url = P.url.trim() || undefined
    }
    if (P.placement !== undefined) {
      if (!PLACEMENTS.includes(P.placement as Placement)) throw new CommandError(`placement must be one of ${PLACEMENTS.join(', ')}`)
      layer.placement = P.placement as Placement
    }
  }

  private defaultLayerName(layer: Layer): string {
    if (layer.kind === 'video') {
      const dev = this.s.inputs.video.find((d) => d.id === layer.device)
      return dev ? dev.name.replace(/\s*\(.*\)$/, '') : 'Video input'
    }
    const names: Record<LayerKind, string> = {
      video: 'Video input',
      screen: 'Screen',
      window: 'Window',
      image: 'Image',
      text: 'Text',
      browser: 'Browser overlay',
      media: 'Media file'
    }
    return names[layer.kind]
  }

  /** A device id the PC can see. An empty id is allowed (pick one later). */
  private device(type: 'video' | 'audio', value: unknown): string | undefined {
    if (value === undefined || value === '') return undefined
    if (typeof value !== 'string') throw new CommandError('device must be text')
    if (!this.s.inputs[type].some((d) => d.id === value)) throw new CommandError(`This PC has no ${type} device ${value}`)
    return value
  }

  /** Input channels of a multichannel interface: one (mono) or two (a pair), counted from 1. */
  private channels(kind: AudioKind, device: string | undefined, value: unknown): number[] | undefined {
    if (value === undefined) return undefined
    const list = this.s.inputs[kind === 'video' ? 'video' : 'audio']
    const max = kind === 'video' ? 2 : channelCount(list.find((d) => d.id === device))
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 2 ||
      !value.every((c) => Number.isInteger(c) && c >= 1 && c <= max) ||
      (value.length === 2 && value[0] === value[1])
    ) {
      throw new CommandError(`channels must be one or two different channel numbers from 1 to ${max}`)
    }
    return [...value]
  }

  private newId(prefix: string): string {
    const taken = new Set([
      ...this.s.scenes.map((x) => x.id),
      ...this.s.scenes.flatMap((x) => x.layers.map((l) => l.id)),
      ...this.s.audio.map((x) => x.id)
    ])
    for (let i = 1; ; i++) if (!taken.has(`${prefix}-${i}`)) return `${prefix}-${i}`
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

function syncOffset(P: Record<string, unknown>): number {
  return Math.round(num(P, 'syncOffsetMs', SYNC_OFFSET_RANGE.min, SYNC_OFFSET_RANGE.max))
}

function name(P: Record<string, unknown>, key: string): string {
  const v = typeof P[key] === 'string' ? (P[key] as string).trim() : ''
  if (!v || v.length > 60) throw new CommandError(`${key} must be 1 to 60 characters`)
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
