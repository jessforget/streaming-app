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
import { BREAK_SOUND, type BreakSound, LAYER_KINDS, PLACEMENTS, ensureOverlay, isOverlay, showScenes, SYNC_OFFSET_RANGE, type InputDevice, type Placement, channelCount, type AppState, type AudioKind, type AudioSource, scenesOnAir, type Health, type HealthStats, type Layer, type LayerKind, type Scene, PHONE_CAM_KEYS, type PhoneCamControl, type PhoneCamValue } from '../shared/state'
import { MAX_DESTINATIONS, PLATFORMS, presetFor, requiredUploadKbps } from '../shared/presets'
import { isValidFieldName, renderTemplate, templateFields } from '../shared/template'
import { Emitter } from './emitter'
import { IDLE_STATS, freshSetup } from './defaults'
import type { DeviceAdmin, Engine, KeyStore, ShowStore, StreamTarget } from './ports'
import { applyShow, isShowFileName, readShow, showFileName, showFingerprint, showFromState } from './show'

export interface ControllerOptions {
  engine: Engine
  keys: KeyStore
  initial: AppState
  devices?: DeviceAdmin
  /** Saved shows. Without it, Save show and Open show say they aren't available. */
  shows?: ShowStore
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
  private readonly shows?: ShowStore
  /** The layout as last saved or opened, to tell when there are changes not saved yet. */
  private savedPrint = ''
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
    this.shows = opts.shows
    this.now = opts.now ?? (() => Date.now())
    this.s = ensureOverlay(structuredClone(opts.initial))
    for (const d of this.s.stream.destinations) {
      d.hasKey = this.keys.has(d.id)
      d.keyEnd = keyEnd(this.keys.get(d.id))
    }
    this.s.show ??= { file: null, savedAt: null, changed: false }
    if (!this.s.show.changed) this.savedPrint = showFingerprint(this.s)
    // The engine says when an output stops on its own (connection lost, the studio page closed).
    this.engine.onNotice = (message) => this.emit('error', message)
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

      case 'phone.facing': {
        const device = str(P, 'device')
        const facing = P.facing
        if (facing !== 'user' && facing !== 'environment') throw new CommandError('facing must be "user" (front) or "environment" (back)')
        if (!device.startsWith('phone:') || !this.s.inputs.video.some((d) => d.id === device)) throw new CommandError('That phone camera is not connected')
        const flips = (this.s.phoneFlips ??= {})
        flips[device] = { facing, seq: (flips[device]?.seq ?? 0) + 1 }
        return this.changed()
      }
      case 'phone.camera': {
        const device = str(P, 'device')
        const dev = this.s.inputs.video.find((d) => d.id === device)
        if (!device.startsWith('phone:') || !dev) throw new CommandError('That phone camera is not connected')
        const raw = P.set
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CommandError('set must be the settings to change')
        const set: Record<string, PhoneCamValue> = {}
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (!(PHONE_CAM_KEYS as readonly string[]).includes(k)) throw new CommandError(`Not a phone camera setting: ${k}`)
          if (v === 'auto' || v === 'manual' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) set[k] = v
          else throw new CommandError(`Bad value for ${k}`)
        }
        const sets = (this.s.phoneSets ??= {})
        sets[device] = { set, seq: (sets[device]?.seq ?? 0) + 1 }
        // Show it right away (the phone confirms a moment later).
        if (dev.camera) dev.camera = dev.camera.map((c) => (c.key in set ? { ...c, value: set[c.key] } : c))
        return this.changed()
      }
      case 'scene.preview': {
        const scene = this.showScene(str(P, 'sceneId'))
        // A half-done fader mix goes with the old Preview.
        if (scene.id !== this.s.previewSceneId) delete this.s.mix
        this.s.previewSceneId = scene.id
        await this.engine.setPreviewScene(scene.id)
        return this.changed()
      }
      case 'scene.program': {
        delete this.s.mix
        await this.takeLive(this.showScene(str(P, 'sceneId')))
        return this.changed()
      }
      case 'scene.goLive': {
        delete this.s.mix
        const next = this.showScene(this.s.previewSceneId)
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
      case 'transition.mix': {
        const level = num(P, 'level', 0, 1)
        if (this.s.previewSceneId === this.s.programSceneId) {
          delete this.s.mix
          return this.changed()
        }
        if (level < 0.999) {
          if (level <= 0) delete this.s.mix
          else this.s.mix = Math.round(level * 1000) / 1000
          return this.changed()
        }
        // The fader reached the end: Preview is on air (already fully mixed in, so a cut), and what was live goes to Preview.
        delete this.s.mix
        const next = this.showScene(this.s.previewSceneId)
        const previous = this.s.programSceneId
        const kind = this.s.transition
        this.s.transition = { ...kind, kind: 'cut' }
        try {
          await this.takeLive(next)
        } finally {
          this.s.transition = kind
        }
        this.s.previewSceneId = previous
        await this.engine.setPreviewScene(previous)
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
        await this.engine.startRecording(r.folder, r.format, this.preset())
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
      case 'settings.setFrameRate': {
        const f = P.frameRate
        if (f !== 'auto' && f !== 'pal' && f !== 'ntsc') throw new CommandError('frameRate must be auto, pal or ntsc')
        if (this.s.stream.live || this.s.recording.active) throw new CommandError('Stop streaming and recording first')
        this.s.stream.frameRate = f
        this.refreshFamily()
        return this.changed()
      }
      case 'settings.setDestination':
        return this.setDestination(P)
      case 'settings.testDestination':
        return this.testDestination(P)
      case 'settings.setRecordFolder': {
        if (this.s.recording.active) throw new CommandError('Stop recording first')
        this.s.recording.folder = str(P, 'folder')
        return this.changed()
      }

      case 'scene.add': {
        // New scenes start in the Scene library; drag them into "In this show" when needed.
        const scene: Scene = { id: this.newId('scene'), name: name(P, 'name'), layers: [], stored: true }
        this.s.scenes.push(scene)
        await this.engine.setScene(scene)
        this.changed()
        return { sceneId: scene.id }
      }
      case 'scene.remove': {
        const scene = this.showScene(str(P, 'sceneId'))
        if (showScenes(this.s.scenes).length === 1) throw new CommandError('Keep at least one scene')
        if (scene.id === this.s.programSceneId) throw new CommandError('That scene is on air. Put another scene live first.')
        this.s.scenes = this.s.scenes.filter((x) => x !== scene)
        if (this.s.previewSceneId === scene.id) this.s.previewSceneId = this.s.programSceneId
        // Forget it in sounds that played in it, and in scenes that showed it.
        for (const a of this.s.audio) {
          if (!a.scenes) continue
          a.scenes = a.scenes.filter((id) => id !== scene.id)
          if (!a.scenes.length) delete a.scenes
        }
        for (const other of this.s.scenes) other.layers = other.layers.filter((l) => !(l.kind === 'scene' && l.sceneId === scene.id))
        // Graphics linked to it go back to every scene... unless they were linked to others too.
        for (const l of this.s.scenes.find(isOverlay)?.layers ?? []) {
          if (!l.onlyIn) continue
          l.onlyIn = l.onlyIn.filter((id) => id !== scene.id)
          if (!l.onlyIn.length) delete l.onlyIn
        }
        await this.engine.removeScene(scene.id)
        return this.changed()
      }
      case 'scene.move': {
        // Change the order of the scene cards (dragged in the main window).
        const scene = this.showScene(str(P, 'sceneId'))
        const to = P.index
        if (typeof to !== 'number' || !Number.isInteger(to)) throw new CommandError('index must be a whole number')
        const list = this.s.scenes
        const from = list.indexOf(scene)
        const at = Math.max(0, Math.min(list.length - 1, to))
        if (from === at) return null
        list.splice(from, 1)
        list.splice(at, 0, scene)
        return this.changed()
      }
      case 'scene.store': {
        const scene = this.showScene(str(P, 'sceneId'))
        if (typeof P.stored !== 'boolean') throw new CommandError('stored must be true or false')
        if (P.stored && scene.id === this.s.programSceneId) throw new CommandError('That scene is on air. Put another scene live first.')
        if (P.stored) scene.stored = true
        else delete scene.stored
        return this.changed()
      }
      case 'scene.rename': {
        this.showScene(str(P, 'sceneId')).name = name(P, 'name')
        return this.changed()
      }
      case 'scene.setHideOverlay': {
        const scene = this.showScene(str(P, 'sceneId'))
        if (bool(P, 'hide')) scene.hideOverlay = true
        else delete scene.hideOverlay
        return this.changed()
      }
      case 'overlay.link': {
        const overlay = this.s.scenes.find(isOverlay)
        const layer = overlay?.layers.find((l) => l.id === str(P, 'layerId'))
        if (!layer) throw new CommandError('No such graphics source')
        const scene = this.showScene(str(P, 'sceneId'))
        if (scene.commercial) throw new CommandError('The Gfx commercial never shows graphics.')
        const now = (layer.onlyIn ?? []).filter((id) => id !== scene.id)
        if (bool(P, 'on')) now.push(scene.id)
        if (now.length) layer.onlyIn = now
        else delete layer.onlyIn
        return this.changed()
      }
      case 'cue.commercial': {
        const given = Array.isArray(P.items) ? (P.items as Record<string, unknown>[]) : [{ name: P.name, path: P.path }]
        if (!given.length || given.length > 20) throw new CommandError('items must hold 1 to 20 videos')
        const items = given.map((x) => {
          const it = x && typeof x === 'object' ? x : {}
          const path = str(it, 'path')
          if (path.length > 2000) throw new CommandError('path is too long')
          const label = typeof it.name === 'string' && it.name.trim() ? it.name.trim().slice(0, 60) : 'Commercial'
          return { name: label, path }
        })
        let scene = this.s.scenes.find((s) => s.commercial)
        if (!scene) {
          scene = { id: this.newId('scene'), name: 'Gfx commercial', layers: [], commercial: true, hideOverlay: true }
          this.s.scenes.push(scene)
        }
        if (scene.name === 'Commercial') scene.name = 'Gfx commercial' // made by an earlier version
        if (scene.id === this.s.programSceneId) {
          // The break on air got longer (or what's still to come changed): keep what has played and
          // what plays now, and put the new list after it.
          if (P.extend !== true) throw new CommandError('A commercial is on air now: cue the next one when it has ended')
          const media = scene.layers.filter((l) => l.kind === 'media')
          const now = media.findIndex((l) => l.visible)
          if (now < 0 || items.length <= now || media.slice(0, now + 1).some((l, i) => l.url !== items[i].path)) {
            throw new CommandError('The break on air has moved on: only the videos still to come can change')
          }
          scene.layers = media.slice(0, now + 1)
          for (const it of items.slice(now + 1)) {
            scene.layers.push({ id: this.newId('layer'), name: it.name, kind: 'media', visible: false, url: it.path, placement: 'full', loop: false, returnAfter: false, sound: true, volume: 1 })
          }
          scene.layers.forEach((l, i) => (l.returnAfter = i === scene!.layers.length - 1))
          await this.engine.setScene(scene)
          return this.changed()
        }
        delete scene.stored
        // In play order: the first shows; each one that ends shows the next (cue.next); the last goes back.
        // (Ids one by one: each new layer must count as taken before the next is named.)
        scene.layers = []
        items.forEach((it, i) =>
          scene.layers.push({
            id: this.newId('layer'),
            name: it.name,
            kind: 'media',
            visible: i === 0,
            url: it.path,
            placement: 'full',
            loop: false,
            returnAfter: i === items.length - 1,
            sound: true,
            volume: 1
          })
        )
        await this.engine.setScene(scene)
        if (this.s.previewSceneId !== scene.id) this.cueBack = this.s.previewSceneId
        this.s.previewSceneId = scene.id
        await this.engine.setPreviewScene(scene.id)
        this.changed()
        return { sceneId: scene.id }
      }
      case 'cue.next': {
        const scene = this.s.scenes.find((s) => s.commercial)
        if (!scene) return null
        const media = scene.layers.filter((l) => l.kind === 'media')
        const at = media.findIndex((l) => l.id === P.layerId)
        // Only the one showing moves on (an old 'ended' for an earlier video changes nothing).
        if (at < 0 || !media[at].visible) return null
        // The last one: a looping break starts again from its first video; otherwise it ends (the studio moves on).
        const next = at < media.length - 1 ? media[at + 1] : scene.breakLoop && media.length > 1 ? media[0] : null
        if (!next) return null
        for (const l of media) l.visible = l === next
        await this.engine.setScene(scene)
        return this.changed()
      }
      case 'cue.sound': {
        const scene = this.s.scenes.find((s) => s.commercial)
        if (!scene) throw new CommandError('No commercial break yet: cue one from the gfx app first')
        const bs = { ...BREAK_SOUND, ...scene.breakSound }
        if (P.volume !== undefined) {
          if (typeof P.volume !== 'number' || !Number.isFinite(P.volume)) throw new CommandError('volume must be a number')
          bs.volume = Math.min(2, Math.max(0, P.volume))
        }
        if (P.muted !== undefined) bs.muted = bool(P, 'muted')
        if (P.mics !== undefined) {
          if (!['off', 'duck', 'on'].includes(P.mics as string)) throw new CommandError('mics must be off, duck or on')
          bs.mics = P.mics as BreakSound['mics']
        }
        scene.breakSound = bs
        return this.changed()
      }
      case 'cue.loop': {
        const scene = this.s.scenes.find((s) => s.commercial)
        if (!scene) throw new CommandError('No commercial break yet: cue one from the gfx app first')
        if (bool(P, 'on')) scene.breakLoop = true
        else delete scene.breakLoop
        return this.changed()
      }
      case 'cue.clear': {
        const scene = this.s.scenes.find((s) => s.commercial)
        if (!scene || scene.id === this.s.programSceneId) return null
        scene.layers = []
        await this.engine.setScene(scene)
        const back = this.s.scenes.find((s) => s.id === this.cueBack && !s.stored && !isOverlay(s))
        if (this.s.previewSceneId === scene.id && back) {
          this.s.previewSceneId = back.id
          await this.engine.setPreviewScene(back.id)
        }
        return this.changed()
      }
      case 'overlay.set': {
        this.s.overlayOn = bool(P, 'on')
        return this.changed()
      }
      case 'layer.add': {
        const scene = this.scene(str(P, 'sceneId'))
        const kind = P.kind as LayerKind
        if (!LAYER_KINDS.includes(kind)) throw new CommandError(`kind must be one of ${LAYER_KINDS.join(', ')}`)
        const layer: Layer = { id: this.newId('layer'), name: '', kind, visible: true }
        this.applyLayerFields(layer, P)
        this.checkNesting(scene, layer)
        if (layer.kind === 'color' && !layer.color) layer.color = '#1e3a8a'
        if (!layer.name) layer.name = this.defaultLayerName(layer)
        scene.layers.unshift(layer) // new sources go on top, like OBS
        await this.engine.setScene(scene)
        if (layer.kind === 'text') await this.pushText(scene, layer)
        // A camera in a scene with no sound of its own yet: the scene's sound is the camera's (follow the picture).
        if (layer.kind === 'video' && layer.device && !isOverlay(scene) && !scene.commercial && !this.s.audio.some((a) => a.scenes?.includes(scene.id))) {
          await this.setSceneSound(scene, this.pictureSound(scene))
        }
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
        const before = structuredClone(layer)
        this.applyLayerFields(layer, P)
        try {
          this.checkNesting(scene, layer)
        } catch (e) {
          Object.assign(layer, before)
          throw e
        }
        await this.engine.setScene(scene)
        if (layer.kind === 'text') await this.pushText(scene, layer)
        return this.changed()
      }
      case 'audio.add': {
        const kind = P.kind as AudioKind
        if (!['device', 'desktop', 'video', 'file'].includes(kind)) throw new CommandError('kind must be device, desktop, video or file')
        const hasDevice = kind === 'device' || kind === 'video'
        const device = hasDevice ? this.device(kind === 'video' ? 'video' : 'audio', P.device) : undefined
        const id = this.newId('audio')
        const channels = hasDevice ? this.channels(kind, device, P.channels) : undefined
        const syncOffsetMs = P.syncOffsetMs === undefined ? 0 : syncOffset(P)
        const src: AudioSource = { id, name: name(P, 'name'), kind, device, channels, syncOffsetMs, volume: 0.8, muted: false, level: 0 }
        if (kind === 'file') {
          src.url = this.fileUrl(P.url)
          src.loop = P.loop === undefined ? true : bool(P, 'loop')
        }
        const scenes = this.sceneList(P.scenes)
        if (scenes) src.scenes = scenes
        this.s.audio.push(src)
        await this.engine.setAudioSources(this.s.audio)
        this.changed()
        return { sourceId: id }
      }
      case 'audio.update': {
        const src = this.audio(str(P, 'sourceId'))
        if (P.name !== undefined) src.name = name(P, 'name')
        if (P.scenes !== undefined) {
          const scenes = this.sceneList(P.scenes)
          if (scenes) src.scenes = scenes
          else delete src.scenes
        }
        if (P.url !== undefined) {
          if (src.kind !== 'file') throw new CommandError('Only music and sound files have a file')
          src.url = this.fileUrl(P.url)
        }
        if (P.loop !== undefined) {
          if (src.kind !== 'file') throw new CommandError('Only music and sound files can loop')
          src.loop = bool(P, 'loop')
        }
        if (P.device !== undefined) {
          if (src.kind === 'desktop' || src.kind === 'file') throw new CommandError('This channel has no device to pick')
          const device = this.device(src.kind === 'video' ? 'video' : 'audio', P.device)
          // Another device has other channels: start again from its first pair.
          if (device !== src.device) src.channels = undefined
          src.device = device
        }
        if (P.channels !== undefined) {
          if (src.kind === 'desktop' || src.kind === 'file') throw new CommandError('This channel has no channels to pick')
          src.channels = this.channels(src.kind, src.device, P.channels)
        }
        if (P.syncOffsetMs !== undefined) src.syncOffsetMs = syncOffset(P)
        await this.engine.setAudioSources(this.s.audio)
        return this.changed()
      }
      case 'scene.setSound': {
        // The one sound for this scene: 'picture' (the sound with its camera), a channel, or none.
        const scene = this.soundScene(str(P, 'sceneId'))
        const want = P.sourceId === null ? null : P.sourceId === 'picture' ? this.pictureSound(scene) : this.audio(str(P, 'sourceId'))
        await this.setSceneSound(scene, want)
        return this.changed()
      }
      case 'scene.addSound': {
        const scene = this.soundScene(str(P, 'sceneId'))
        const src = P.sourceId === 'picture' ? this.pictureSound(scene) : this.audio(str(P, 'sourceId'))
        const set = new Set(src.scenes ?? this.soundSceneIds())
        set.add(scene.id)
        src.scenes = [...set]
        await this.engine.setAudioSources(this.s.audio)
        return this.changed()
      }
      case 'scene.removeSound': {
        const scene = this.soundScene(str(P, 'sceneId'))
        const src = this.audio(str(P, 'sourceId'))
        src.scenes = (src.scenes ?? this.soundSceneIds()).filter((id) => id !== scene.id)
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
            if (d.facing === 'user' || d.facing === 'environment') out.facing = d.facing
            if (Array.isArray(d.camera)) out.camera = phoneCamControls(d.camera)
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
      case 'studio.cameraRate': {
        const family = P.family === 'pal' || P.family === 'ntsc' ? P.family : null
        const note = typeof P.note === 'string' ? P.note.slice(0, 200) : ''
        const st = this.s.stream
        if (st.cameras.family === family && st.cameras.note === note) return null
        st.cameras = { family, note }
        this.refreshFamily()
        this.changed()
        return null
      }
      case 'inputs.refresh':
        await this.refreshInputs()
        return this.changed()

      case 'show.list': {
        const store = this.showStore()
        const shows = store.list().sort((a, b) => b.savedAt - a.savedAt)
        return { folder: store.folder, shows }
      }
      case 'show.save': {
        const store = this.showStore()
        // Save: the show's own file. Save as (a name): a new file with that name.
        const asName = P.name === undefined ? '' : name(P, 'name')
        const showName = asName || this.s.setupName
        const file = asName || !this.s.show.file ? showFileName(showName) : this.s.show.file
        const at = this.now()
        try {
          store.write(file, showFromState(this.s, showName, at))
        } catch (e) {
          throw new CommandError(`Could not save the project: ${errorText(e)}`)
        }
        this.s.setupName = showName
        this.markSaved(file, at)
        this.changed()
        return { file, name: showName }
      }
      case 'show.open': {
        const file = P.file
        if (!isShowFileName(file)) throw new CommandError('Pick a project from the list')
        let raw: unknown
        try {
          raw = this.showStore().read(file)
        } catch (e) {
          throw new CommandError(`Could not open the project: ${errorText(e)}`)
        }
        const show = readShow(raw)
        await this.loadShow(() => applyShow(this.s, show, this.now()))
        this.markSaved(file, show.savedAt || null)
        this.changed()
        return { file, name: this.s.setupName }
      }
      case 'show.import': {
        // A show file from another PC (or a USB stick): opened, and kept in the shows folder.
        const show = readShow(P.show)
        const store = this.showStore()
        const taken = new Set(store.list().map((x) => x.file))
        let file = showFileName(show.name)
        for (let i = 2; taken.has(file); i++) file = showFileName(`${show.name} (${i})`)
        await this.loadShow(() => applyShow(this.s, show, this.now()))
        const at = this.now()
        try {
          store.write(file, showFromState(this.s, this.s.setupName, at))
        } catch (e) {
          throw new CommandError(`The project is open, but could not be kept in the projects folder: ${errorText(e)}`)
        }
        this.markSaved(file, at)
        this.changed()
        return { file, name: this.s.setupName }
      }
      case 'show.new': {
        // A fresh layout. This PC's platforms, quality and recording folder carry over.
        const showName = name(P, 'name')
        const fresh = freshSetup()
        fresh.inputs = this.s.inputs
        fresh.stream = { ...this.s.stream, destinations: this.s.stream.destinations.map((d) => ({ ...d, enabled: false })) }
        fresh.recording = { ...this.s.recording }
        const show = showFromState(fresh, showName, 0)
        await this.loadShow(() => applyShow(this.s, show, this.now()))
        this.s.data = {}
        this.s.show = { file: null, savedAt: null, changed: true }
        this.savedPrint = ''
        this.changed()
        return { name: showName }
      }
      case 'show.delete': {
        const file = P.file
        if (!isShowFileName(file)) throw new CommandError('Pick a project from the list')
        try {
          this.showStore().remove(file)
        } catch (e) {
          throw new CommandError(`Could not delete the project: ${errorText(e)}`)
        }
        if (this.s.show.file === file) {
          this.s.show = { file: null, savedAt: null, changed: true }
          this.savedPrint = ''
        }
        return this.changed()
      }
      case 'show.export':
        return showFromState(this.s, this.s.setupName, this.now())

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
      const url = d.serverUrl || info.ingestUrl
      if (!url) throw new CommandError(`Add the ${info.label} server address in Go Live settings`)
      targets.push({ destinationId: d.id, platform: d.platform, url, key, vertical: d.vertical })
    }
    await this.engine.startStream(targets, this.preset())
    this.s.stream.live = true
    this.s.stream.startedAt = this.now()
    return this.changed()
  }

  /** Ask the platform whether it knows the saved key, without going live. */
  private async testDestination(P: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const id = str(P, 'id')
    const d = this.s.stream.destinations.find((x) => x.id === id)
    if (!d) throw new CommandError(`No platform with id ${id}`)
    const info = PLATFORMS[d.platform]
    const key = this.keys.get(d.id)
    if (!key) return { ok: false, message: `No ${info.label} stream key saved yet. Paste it and press Save key first.` }
    const url = d.serverUrl || info.ingestUrl
    if (!url) return { ok: false, message: `Add the ${info.label} server address first.` }
    if (!this.engine.checkStreamKey) return { ok: false, message: 'Checking keys is not available in practice mode.' }
    return this.engine.checkStreamKey(url, key)
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
      // Same as the built-in address (or blank): keep following the built-in one.
      d.serverUrl = url && url !== PLATFORMS[d.platform].ingestUrl ? url : undefined
    }
    if (P.streamKey !== undefined) {
      this.keys.set(d.id, String(P.streamKey).trim())
      d.hasKey = this.keys.has(d.id)
      d.keyEnd = keyEnd(this.keys.get(d.id))
    }
    return this.changed()
  }

  // ---------- Scenes ----------

  private async takeLive(scene: Scene) {
    // A scene from the Scene library that goes on air joins this show.
    delete scene.stored
    // A commercial break always starts from its first video.
    const media = scene.commercial ? scene.layers.filter((l) => l.kind === 'media') : []
    if (media.length > 1 && !media[0].visible) {
      for (const l of media) l.visible = l === media[0]
      await this.engine.setScene(scene)
    }
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
      // The stream's own word on whether the platforms are getting it, before anything else.
      if (this.s.stream.live && raw.streamOut) {
        const names = this.s.stream.destinations
          .filter((d) => d.enabled)
          .map((d) => PLATFORMS[d.platform].label)
          .join(' and ')
        if (raw.streamOut === 'connecting') {
          health = 'warning'
          message = `Connecting to ${names}…`
        } else if (raw.streamOut === 'stuck') {
          health = 'bad'
          message = `Not reaching ${names}. The app keeps trying; check the stream key (Settings, Test key) and the internet.`
        } else if (health === 'good') {
          const mbps = raw.streamKbps ? `, ${(raw.streamKbps / 1000).toFixed(1)} Mbps` : ''
          message = `Connected to ${names}, sending video${mbps}`
        }
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
    this.refreshFamily()
  }

  /**
   * Pick 25/50 or 30/60 frames a second: the person's fixed choice, or what the cameras send.
   * Never while streaming or recording (the picture would change speed mid-stream); it catches
   * up when both stop. Cameras that disagree keep the current one.
   */
  private refreshFamily() {
    const st = this.s.stream
    if (st.live || this.s.recording.active) return
    if (st.frameRate !== 'auto') st.family = st.frameRate
    else if (st.cameras.family) st.family = st.cameras.family
  }

  /** The quality and frame rate the stream and recording use now. */
  private preset() {
    return presetFor(this.s.stream.quality, this.s.stream.family)
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
      for (const id of was) if (!is.has(id) && used.has(id)) this.emit('error', `${named(id)} ${id.startsWith('phone:') ? 'disconnected' : 'was unplugged'}`)
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
    if (layer.kind === 'graphics' && layer.url) layer.url = graphicsUrl(layer.url)
    if (P.size !== undefined) {
      if (P.size === null || P.size === '') layer.size = undefined
      else if (!(P.size === '1080p' || P.size === '720p')) throw new CommandError('size must be 1080p or 720p')
      else layer.size = P.size
    }
    if (P.fps !== undefined) {
      // 0 or empty: the same as the stream.
      layer.fps = P.fps === null || P.fps === '' || P.fps === 0 ? undefined : num(P, 'fps', 1, 60)
    }
    if (P.placement !== undefined) {
      if (!PLACEMENTS.includes(P.placement as Placement)) throw new CommandError(`placement must be one of ${PLACEMENTS.join(', ')}`)
      layer.placement = P.placement as Placement
    }
    if (P.loop !== undefined) layer.loop = bool(P, 'loop')
    if (P.returnAfter !== undefined) layer.returnAfter = bool(P, 'returnAfter')
    if (P.sound !== undefined) layer.sound = bool(P, 'sound')
    if (P.volume !== undefined) layer.volume = num(P, 'volume', 0, 1)
    if (P.color !== undefined) {
      if (typeof P.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(P.color)) throw new CommandError('color must look like #1e3a8a')
      layer.color = P.color
    }
    if (P.until !== undefined) {
      if (P.until === '' || P.until === null) layer.until = undefined
      else if (typeof P.until !== 'string' || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(P.until)) throw new CommandError('until must be a time like 19:30')
      else layer.until = P.until
    }
    if (P.minutes !== undefined) layer.minutes = num(P, 'minutes', 0, 24 * 60)
    if (P.seconds !== undefined) layer.seconds = num(P, 'seconds', 1, 3600)
    if (P.showScene !== undefined) {
      if (layer.kind !== 'scene') throw new CommandError('Only scene sources show another scene')
      layer.sceneId = this.showScene(str(P, 'showScene')).id
    }
  }

  /** A scene shown inside another must not end up showing itself. */
  private checkNesting(scene: Scene, layer: Layer) {
    if (layer.kind !== 'scene') return
    if (!layer.sceneId) throw new CommandError('Pick which scene to show')
    if (scenesOnAir({ scenes: this.s.scenes, programSceneId: '' }, layer.sceneId).has(scene.id)) throw new CommandError('A scene can’t show itself, even through another scene')
  }

  /** Which scenes a sound plays in: absent or empty = every scene. */
  private sceneList(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value) || value.length > 100) throw new CommandError('scenes must be a list of scene ids')
    const ids = [...new Set(value.map((v) => (typeof v === 'string' ? v : '')))]
    for (const id of ids) this.scene(id)
    return ids.length ? ids : undefined
  }

  /** A music or sound file for a 'file' channel. */
  private fileUrl(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new CommandError('Pick a music or sound file')
    return value.trim()
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
      graphics: 'Graphics',
      media: 'Media file',
      bars: 'Color bars',
      color: 'Color',
      countdown: 'Countdown',
      slideshow: 'Slideshow',
      scene: this.s.scenes.find((x) => x.id === layer.sceneId)?.name ?? 'Scene'
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

  /** A scene whose sound can be picked (not the Overlay, not the Gfx commercial: that plays its videos' sound only). */
  private soundScene(id: string): Scene {
    const scene = this.showScene(id)
    if (scene.commercial) throw new CommandError('The Gfx commercial plays only its videos’ sound')
    return scene
  }

  /** Every scene a sound can play in (what "every scene" means when one scene is taken out). */
  private soundSceneIds(): string[] {
    return this.s.scenes.filter((s) => !isOverlay(s) && !s.commercial).map((s) => s.id)
  }

  /** The sound that comes with the scene's camera: its channel, made the first time. */
  private pictureSound(scene: Scene): AudioSource {
    const cam = scene.layers.find((l) => l.kind === 'video' && l.device && l.visible) ?? scene.layers.find((l) => l.kind === 'video' && l.device)
    if (!cam?.device) throw new CommandError('This scene has no camera or video input to take the sound from')
    const have = this.s.audio.find((a) => a.kind === 'video' && a.device === cam.device)
    if (have) return have
    const dev = this.s.inputs.video.find((d) => d.id === cam.device)
    // The same box's audio input already in the Sound panel (the ATEM Mini's USB audio with its picture).
    const boxAudio = dev?.group ? this.s.inputs.audio.filter((d) => d.group === dev.group).map((d) => d.id) : []
    const box = this.s.audio.find((a) => a.kind === 'device' && !!a.device && boxAudio.includes(a.device))
    if (box) return box
    const src: AudioSource = { id: this.newId('audio'), name: `${dev?.name ?? cam.name} sound`.slice(0, 60), kind: 'video', device: cam.device, syncOffsetMs: 0, scenes: [], volume: 0.8, muted: false, level: 0 }
    this.s.audio.push(src)
    return src
  }

  /** Make this the scene's only sound (null: no sound). Other scenes keep theirs. */
  private async setSceneSound(scene: Scene, want: AudioSource | null) {
    const all = this.soundSceneIds()
    for (const a of this.s.audio) {
      const set = new Set(a.scenes ?? all)
      if (a === want) set.add(scene.id)
      else set.delete(scene.id)
      a.scenes = [...set]
    }
    await this.engine.setAudioSources(this.s.audio)
  }

  /** What was in Preview before a commercial was cued there. */
  private cueBack = ''

  private newId(prefix: string): string {
    const taken = new Set([
      ...this.s.scenes.map((x) => x.id),
      ...this.s.scenes.flatMap((x) => x.layers.map((l) => l.id)),
      ...this.s.audio.map((x) => x.id)
    ])
    for (let i = 1; ; i++) if (!taken.has(`${prefix}-${i}`)) return `${prefix}-${i}`
  }

  private changed(): AppState {
    if (!this.s.show.changed && showFingerprint(this.s) !== this.savedPrint) this.s.show.changed = true
    this.emit('state', this.s)
    return this.s
  }

  /** A scene, or the Overlay (its sources are edited like a scene's). */
  private scene(id: string): Scene {
    const scene = this.s.scenes.find((x) => x.id === id)
    if (!scene) throw new CommandError(`No scene with id ${id}`)
    return scene
  }

  /** A scene that can be a card, go to Preview or Live: not the Overlay. */
  private showScene(id: string): Scene {
    if (isOverlay(id)) throw new CommandError('The Overlay isn’t a scene: it sits on top of every scene. Scenes can hide it with “Hide the Overlay in this scene”.')
    return this.scene(id)
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

  private showStore(): ShowStore {
    if (!this.shows) throw new CommandError('Saving projects isn’t available here')
    return this.shows
  }

  private markSaved(file: string, savedAt: number | null) {
    this.s.show = { file, savedAt, changed: false }
    this.savedPrint = showFingerprint(this.s)
  }

  /**
   * Swap in another show's layout. Not while streaming or recording: the
   * picture on air would change all at once.
   */
  private async loadShow(apply: () => void) {
    if (this.s.stream.live || this.s.recording.active) throw new CommandError('Stop streaming and recording first, then open the project.')
    const before = this.s.scenes.map((x) => x.id)
    apply()
    this.cueBack = ''
    for (const id of before) if (!this.s.scenes.some((x) => x.id === id)) await this.engine.removeScene(id)
    for (const scene of this.s.scenes) await this.engine.setScene(scene)
    await this.engine.setAudioSources(this.s.audio)
    await this.engine.setProgramScene(this.s.programSceneId, { kind: 'cut', durationMs: 0 })
    await this.engine.setPreviewScene(this.s.previewSceneId)
    this.refreshFamily()
    await this.refreshAllTexts()
  }

  private deviceAdmin(): DeviceAdmin {
    if (!this.devices) throw new CommandError('Device pairing is not available')
    return this.devices
  }
}

/**
 * A gfx app's address, as people type it: "192.168.101.50:8765/live" works
 * too (http:// is added). Only web addresses can be graphics pages.
 */
export function graphicsUrl(raw: string): string {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new CommandError('That address doesn’t look right. It should look like http://192.168.101.50:8765/live')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CommandError('The address must start with http:// or https://')
  return url
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

/** The last 4 characters of a stream key, so it can be matched against the platform's (the rest stays secret). */
function keyEnd(key: string | undefined): string | undefined {
  return key && key.length > 8 ? key.slice(-4) : undefined
}

/** A phone's list of camera settings, checked (it comes from the phone page). */
function phoneCamControls(v: unknown[]): PhoneCamControl[] {
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
  const out: PhoneCamControl[] = []
  for (const c of v.slice(0, 12) as Record<string, unknown>[]) {
    if (!c || typeof c.key !== 'string' || !(PHONE_CAM_KEYS as readonly string[]).includes(c.key)) continue
    const type = c.type === 'mode' || c.type === 'bool' ? c.type : 'range'
    const value = c.value === 'auto' || c.value === 'manual' || typeof c.value === 'boolean' ? c.value : num(c.value)
    if (value === undefined) continue
    const d: PhoneCamControl = { key: c.key, label: String(c.label ?? c.key).slice(0, 40), type, value }
    if (type === 'mode') d.options = ['auto', 'manual']
    if (type === 'range') {
      const min = num(c.min)
      const max = num(c.max)
      if (min === undefined || max === undefined || !(max > min)) continue
      Object.assign(d, { min, max, step: num(c.step) ?? 0 })
      if (typeof c.unit === 'string') d.unit = c.unit.slice(0, 8)
      if (c.scale === 'log' && min > 0) d.scale = 'log'
      if (c.fmt === 'shutter') d.fmt = 'shutter'
    }
    if (Array.isArray(c.show) && typeof c.show[0] === 'string' && typeof c.show[1] === 'string') d.show = [c.show[0].slice(0, 20), c.show[1].slice(0, 20)]
    out.push(d)
  }
  return out
}
