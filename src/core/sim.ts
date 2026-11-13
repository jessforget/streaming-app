/**
 * Simulated engine and ATEM. Used for development without hardware, for the
 * interactive mockup, and in tests. They behave like the real thing: an ATEM
 * auto transition takes a second, streaming produces frames and audio levels.
 */
import type { AppState } from '../shared/state'
import type { QualityPreset } from '../shared/presets'
import type { AtemLink, AtemSnapshot, Engine, EngineStats, StreamTarget } from './ports'

export class SimEngine implements Engine {
  readonly name = 'simulated'
  streaming: StreamTarget[] = []
  recording = false
  program = ''
  preview = ''
  texts = new Map<string, string>()
  private frames = 0
  private dropped = 0
  private fps = 30
  private volumes = new Map<string, { volume: number; muted: boolean }>()
  /** Tests can set this to simulate a slow upload (0 to 1 of frames dropped). */
  dropRate = 0

  async init(state: AppState) {
    this.program = state.programSceneId
    this.preview = state.previewSceneId
    for (const a of state.audio) this.volumes.set(a.id, { volume: a.volume, muted: a.muted })
  }
  async setPreviewScene(sceneId: string) {
    this.preview = sceneId
  }
  async setProgramScene(sceneId: string) {
    this.program = sceneId
  }
  async setLayerVisible() {}
  async setLayerText(sceneId: string, layerId: string, text: string) {
    this.texts.set(`${sceneId}/${layerId}`, text)
  }
  async setVolume(id: string, volume: number) {
    this.volumes.set(id, { ...(this.volumes.get(id) ?? { muted: false }), volume })
  }
  async setMuted(id: string, muted: boolean) {
    this.volumes.set(id, { ...(this.volumes.get(id) ?? { volume: 1 }), muted })
  }
  async startStream(targets: StreamTarget[], preset: QualityPreset) {
    this.streaming = targets
    this.fps = preset.fps
  }
  async stopStream() {
    this.streaming = []
  }
  async startRecording(_folder: string, _format: 'mp4' | 'mkv', preset: QualityPreset) {
    this.recording = true
    this.fps = preset.fps
  }
  async stopRecording() {
    this.recording = false
  }
  readStats(): EngineStats {
    const active = this.streaming.length > 0 || this.recording
    if (active) {
      this.frames += this.fps
      this.dropped += Math.round(this.fps * this.dropRate)
    }
    const audioLevels: Record<string, number> = {}
    for (const [id, v] of this.volumes) {
      audioLevels[id] = v.muted ? 0 : Math.min(1, v.volume * (0.55 + Math.random() * 0.4))
    }
    return {
      fps: this.fps,
      cpu: active ? 18 + Math.round(Math.random() * 6) : 4,
      droppedFrames: this.dropped,
      totalFrames: this.frames,
      audioLevels
    }
  }
  async shutdown() {}
}

export class SimAtem implements AtemLink {
  private snapshot: AtemSnapshot = {
    connected: false,
    model: '',
    inputs: [],
    program: null,
    preview: null,
    inTransition: false
  }
  private listeners: ((s: AtemSnapshot) => void)[] = []
  /** Auto transition length in ms. */
  autoMs = 1000

  async connect() {
    this.snapshot = {
      connected: true,
      model: 'ATEM Mini Pro (simulated)',
      inputs: [
        { id: 1, shortName: 'CAM1', longName: 'Wide' },
        { id: 2, shortName: 'CAM2', longName: 'Host' },
        { id: 3, shortName: 'CAM3', longName: 'Guest' },
        { id: 4, shortName: 'CAM4', longName: 'Overhead' }
      ],
      program: 1,
      preview: 2,
      inTransition: false
    }
    this.publish()
  }
  async disconnect() {
    this.snapshot = { ...this.snapshot, connected: false }
    this.publish()
  }
  async setPreview(input: number) {
    this.snapshot = { ...this.snapshot, preview: input }
    this.publish()
  }
  async setProgram(input: number) {
    this.snapshot = { ...this.snapshot, program: input }
    this.publish()
  }
  async cut() {
    const { program, preview } = this.snapshot
    this.snapshot = { ...this.snapshot, program: preview, preview: program }
    this.publish()
  }
  async auto() {
    if (this.snapshot.inTransition) return
    this.snapshot = { ...this.snapshot, inTransition: true }
    this.publish()
    await new Promise((r) => setTimeout(r, this.autoMs))
    await this.cut()
    this.snapshot = { ...this.snapshot, inTransition: false }
    this.publish()
  }
  onChange(fn: (s: AtemSnapshot) => void) {
    this.listeners.push(fn)
  }
  private publish() {
    const s = { ...this.snapshot, inputs: [...this.snapshot.inputs] }
    this.listeners.forEach((fn) => fn(s))
  }
}
