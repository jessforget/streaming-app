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
    { id: 'atem-mini-audio', name: 'Blackmagic Design (ATEM Mini, USB audio)', driver: 'wasapi', channels: 2 },
    { id: 'usb-mic', name: 'USB microphone', driver: 'wasapi', channels: 2 },
    {
      id: 'zoom-l12',
      name: 'ZOOM L-12 (ASIO)',
      driver: 'asio',
      channels: 14,
      channelNames: [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Ch ${n}`),
        'Ch 9/10 L',
        'Ch 9/10 R',
        'Ch 11/12 L',
        'Ch 11/12 R',
        'Master L',
        'Master R'
      ]
    },
    {
      id: 'scarlett-asio',
      name: 'Focusrite USB ASIO (Scarlett 18i20)',
      driver: 'asio',
      channels: 18,
      channelNames: [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Analogue ${n}`),
        'S/PDIF L',
        'S/PDIF R',
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `ADAT ${n}`)
      ]
    },
    { id: 'scarlett-1-2', name: 'Focusrite USB Audio · Analogue 1 + 2', driver: 'wasapi', channels: 2 }
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
  /** The devices this pretend PC can see; tests plug and unplug by editing it. */
  devices = structuredClone(SIM_DEVICES)

  async init(state: AppState) {
    this.program = state.programSceneId
    this.preview = state.previewSceneId
    for (const scene of state.scenes) this.scenes.set(scene.id, structuredClone(scene))
    await this.setAudioSources(state.audio)
  }
  async listDevices() {
    return structuredClone(this.devices)
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
