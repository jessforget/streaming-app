/**
 * Real video engine: OBS's libobs, reached through obs-studio-node (the
 * Node.js binding Streamlabs maintains). Windows first.
 *
 * STATUS: written against obs-studio-node's published API but NOT yet run on
 * a Windows PC with an ATEM attached. Expect small fixes on the first real
 * run (Phase 1). Until then the app falls back to the simulated engine and
 * says so in the top bar.
 *
 * Install: obs-studio-node is not on the public npm registry in a current
 * version. Download the Windows build from Streamlabs' releases and install
 * it with `npm install <path-or-url-to-tarball>`. See docs/ENGINE.md.
 */
import { join } from 'node:path'
import type { AppState, Layer, Scene } from '../../shared/state'
import type { QualityPreset } from '../../shared/presets'
import type { Engine, EngineStats, StreamTarget } from '../../core/ports'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Osn = any

/** libobs source type for each layer kind (Windows). */
const SOURCE_TYPE: Record<Layer['kind'], string> = {
  atem: 'dshow_input',
  webcam: 'dshow_input',
  screen: 'monitor_capture',
  window: 'window_capture',
  image: 'image_source',
  text: 'text_gdiplus',
  browser: 'browser_source',
  media: 'ffmpeg_source'
}

/** The ATEM Mini shows up in Windows as a webcam with this name. */
const ATEM_WEBCAM_NAME = 'Blackmagic Design'

export class ObsEngine implements Engine {
  readonly name = 'obs'
  private osn: Osn
  private scenes = new Map<string, any>()
  private items = new Map<string, any>()
  private inputs = new Map<string, any>()
  private audio = new Map<string, any>()
  private transition: any
  private streams: any[] = []
  private recording: any = null
  private lastStats: EngineStats = { fps: 0, cpu: 0, droppedFrames: 0, totalFrames: 0, audioLevels: {} }

  constructor(
    private readonly dataDir: string,
    private readonly version: string
  ) {}

  /** Throws a plain-words error when obs-studio-node isn't installed. */
  static load(): Osn {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('obs-studio-node')
    } catch {
      throw new Error('The video engine (obs-studio-node) is not installed. See docs/ENGINE.md.')
    }
  }

  async init(state: AppState) {
    const osn = (this.osn = ObsEngine.load())
    const moduleDir = join(require.resolve('obs-studio-node'), '..')
    osn.NodeObs.IPC.host(`streaming-app-${process.pid}`)
    osn.NodeObs.SetWorkingDirectory(moduleDir)
    const code = osn.NodeObs.OBS_API_initAPI('en-US', this.dataDir, this.version, '')
    if (code !== 0) throw new Error(`The video engine could not start (code ${code})`)

    const preset = { width: 1920, height: 1080, fps: 30 }
    this.applyVideo(preset)

    for (const scene of state.scenes) this.buildScene(scene)
    for (const a of state.audio) this.buildAudio(a.id, a.name, a.volume, a.muted)

    this.transition = osn.TransitionFactory.create('fade_transition', 'Fade', {})
    osn.Global.setOutputSource(0, this.transition)
    this.transition.set(this.scenes.get(state.programSceneId))
  }

  private applyVideo(p: { width: number; height: number; fps: number }) {
    const ctx = this.osn.VideoFactory.create()
    ctx.video = {
      fpsNum: p.fps,
      fpsDen: 1,
      baseWidth: p.width,
      baseHeight: p.height,
      outputWidth: p.width,
      outputHeight: p.height,
      outputFormat: this.osn.EVideoFormat.NV12,
      colorspace: this.osn.EColorSpace.CS709,
      range: this.osn.ERangeType.Default,
      scaleType: this.osn.EScaleType.Bicubic,
      fpsType: this.osn.EFPSType.Integer
    }
  }

  private buildScene(scene: Scene) {
    const osnScene = this.osn.SceneFactory.create(scene.name)
    this.scenes.set(scene.id, osnScene)
    // libobs draws the last-added item on top; our list has the top layer first.
    for (const layer of [...scene.layers].reverse()) {
      const input = this.osn.InputFactory.create(SOURCE_TYPE[layer.kind], `${scene.id}/${layer.id}`, this.settingsFor(layer))
      this.inputs.set(`${scene.id}/${layer.id}`, input)
      const item = osnScene.add(input)
      item.visible = layer.visible
      this.items.set(`${scene.id}/${layer.id}`, item)
    }
  }

  private settingsFor(layer: Layer): Record<string, unknown> {
    switch (layer.kind) {
      case 'atem':
        // Pick the ATEM's USB webcam by name; the user can change it in Advanced options.
        return { video_device_id: ATEM_WEBCAM_NAME, res_type: 1, resolution: '1920x1080' }
      case 'text':
        return { text: layer.text ?? '', font: { face: 'Arial', size: 72 } }
      case 'image':
        return layer.url ? { file: layer.url } : {}
      case 'browser':
        return { url: layer.url ?? '', width: 1920, height: 1080 }
      case 'media':
        return layer.url ? { local_file: layer.url, looping: true } : {}
      default:
        return {}
    }
  }

  private buildAudio(id: string, name: string, volume: number, muted: boolean) {
    const type = id === 'desktop' ? 'wasapi_output_capture' : id === 'atem-audio' ? 'wasapi_input_capture' : 'wasapi_input_capture'
    const input = this.osn.InputFactory.create(type, name, {})
    input.volume = volume
    input.muted = muted
    this.osn.Global.setOutputSource(this.audio.size + 1, input)
    this.audio.set(id, input)
  }

  async setPreviewScene() {
    // The preview is drawn by the interface (Phase 2: OBS_content_createSourcePreviewDisplay).
  }

  async setProgramScene(sceneId: string, transition: AppState['transition']) {
    const scene = this.scenes.get(sceneId)
    if (!scene) throw new Error(`Unknown scene ${sceneId}`)
    if (transition.kind === 'cut') this.transition.set(scene)
    else this.transition.start(transition.durationMs, scene)
  }

  async setLayerVisible(sceneId: string, layerId: string, visible: boolean) {
    const item = this.items.get(`${sceneId}/${layerId}`)
    if (item) item.visible = visible
  }

  async setLayerText(sceneId: string, layerId: string, text: string) {
    const input = this.inputs.get(`${sceneId}/${layerId}`)
    if (input) input.update({ ...input.settings, text })
  }

  async setVolume(id: string, volume: number) {
    const input = this.audio.get(id)
    if (input) input.volume = volume
  }

  async setMuted(id: string, muted: boolean) {
    const input = this.audio.get(id)
    if (input) input.muted = muted
  }

  async startStream(targets: StreamTarget[], preset: QualityPreset) {
    this.applyVideo(preset)
    // One output per platform. Vertical (Instagram) layout is Phase 2; until then it gets the wide picture.
    for (const t of targets) {
      const stream = this.osn.AdvancedStreamingFactory.create()
      stream.videoEncoder = this.bestEncoder(preset)
      stream.service = this.osn.ServiceFactory.create('rtmp_custom', `service-${t.destinationId}`, {
        server: t.url,
        key: t.key
      })
      stream.signalHandler = (signal: { signal: string; error?: string }) => {
        if (signal.signal === 'stop' && signal.error) console.error(`[stream ${t.platform}]`, signal.error)
      }
      stream.start()
      this.streams.push(stream)
    }
  }

  async stopStream() {
    for (const s of this.streams) s.stop()
    this.streams = []
  }

  async startRecording(folder: string, format: 'mp4' | 'mkv', preset: QualityPreset) {
    const rec = this.osn.AdvancedRecordingFactory.create()
    rec.path = folder
    rec.format = format
    rec.videoEncoder = this.bestEncoder(preset)
    rec.start()
    this.recording = rec
  }

  async stopRecording() {
    this.recording?.stop()
    this.recording = null
  }

  /** Hardware encoder when the PC has one (NVIDIA, AMD, Intel), else x264. */
  private bestEncoder(preset: QualityPreset) {
    const available: string[] = this.osn.VideoEncoderFactory.types()
    const type = ['jim_nvenc', 'h264_texture_amf', 'obs_qsv11'].find((t) => available.includes(t)) ?? 'obs_x264'
    return this.osn.VideoEncoderFactory.create(type, `encoder-${type}`, {
      rate_control: 'CBR',
      bitrate: preset.videoKbps,
      keyint_sec: 2
    })
  }

  readStats(): EngineStats {
    try {
      const perf = this.osn.NodeObs.OBS_API_getPerformanceStatistics()
      const audioLevels: Record<string, number> = {}
      for (const id of this.audio.keys()) audioLevels[id] = this.lastStats.audioLevels[id] ?? 0
      this.lastStats = {
        fps: Math.round(perf.frameRate ?? 0),
        cpu: Math.round(perf.CPU ?? 0),
        droppedFrames: perf.numberDroppedFrames ?? 0,
        totalFrames: Math.round((perf.frameRate ?? 0) * 1) + this.lastStats.totalFrames,
        audioLevels
      }
    } catch {
      // keep the last numbers
    }
    return this.lastStats
  }

  async shutdown() {
    if (!this.osn) return
    try {
      await this.stopStream()
      await this.stopRecording()
      this.osn.NodeObs.OBS_service_removeCallback?.()
      this.osn.NodeObs.IPC.disconnect()
    } catch {
      // shutting down anyway
    }
  }
}
