/**
 * Simulated engine. Used for development without hardware, for the
 * interactive mockup, and in tests. It behaves like the real thing: it lists
 * an ATEM Mini and a HyperDeck capture card, and streaming produces frames and
 * audio levels.
 */
import type { AppState, AudioSource, InputDevice, Scene } from '../shared/state'
import type { QualityPreset } from '../shared/presets'
import type { Engine, EngineStats, StreamTarget } from './ports'

export const SIM_DEVICES: { video: InputDevice[]; audio: InputDevice[] } = {
  video: [
    { id: 'atem-mini', name: 'Blackmagic Design (ATEM Mini, USB)' },
    { id: 'decklink-1', name: 'DeckLink Mini Recorder (HyperDeck)' },
    { id: 'usb-capture', name: 'USB HDMI capture' }
  ],
  audio: [
    { id: 'atem-mini-audio', name: 'Blackmagic Design (ATEM Mini, USB audio)' },
    { id: 'usb-mic', name: 'USB microphone' }
  ]
}

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

  scenes = new Map<string, Scene>()

  async init(state: AppState) {
    this.program = state.programSceneId
    this.preview = state.previewSceneId
    for (const scene of state.scenes) this.scenes.set(scene.id, structuredClone(scene))
    await this.setAudioSources(state.audio)
  }
  async listDevices() {
    return structuredClone(SIM_DEVICES)
  }
  async setScene(scene: Scene) {
    this.scenes.set(scene.id, structuredClone(scene))
  }
  async removeScene(sceneId: string) {
    this.scenes.delete(sceneId)
  }
  async setAudioSources(sources: AudioSource[]) {
    this.volumes = new Map(sources.map((a) => [a.id, { volume: a.volume, muted: a.muted }]))
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
