/**
 * The pieces the controller drives. Each has a real version (in src/main) and
 * a simulated one (in src/core/sim) so the app, the tablet remote and the
 * tests all run without OBS's engine or capture hardware attached.
 */
import type { AppState, AudioSource, InputDevice, Platform, Scene } from '../shared/state'
import type { QualityPreset } from '../shared/presets'
import type { Role } from '../shared/protocol'

export interface StreamTarget {
  destinationId: string
  platform: Platform
  url: string
  key: string
  vertical: boolean
}

export interface EngineStats {
  fps: number
  cpu: number
  droppedFrames: number
  totalFrames: number
  audioLevels: Record<string, number>
  /**
   * While streaming: is video really going out to the platforms? 'sending' = the platform accepted
   * the stream and video is flowing; 'connecting' = not yet; 'stuck' = nothing went out for a while.
   */
  streamOut?: 'connecting' | 'sending' | 'stuck'
  /** Kbit/s going out to the platforms, as ffmpeg reports it. */
  streamKbps?: number
}

/** Video engine: capture, compositing, encoding, streaming, recording. */
export interface Engine {
  readonly name: string
  init(state: AppState): Promise<void>
  /** Capture and audio devices the PC can see (ATEM Mini, capture cards, mics). */
  listDevices(): Promise<{ video: InputDevice[]; audio: InputDevice[] }>
  /** Create or rebuild a scene from its definition (after any edit to its sources). */
  setScene(scene: Scene): Promise<void>
  removeScene(sceneId: string): Promise<void>
  /** Make the mixer match this list of channels. */
  setAudioSources(sources: AudioSource[]): Promise<void>
  setPreviewScene(sceneId: string): Promise<void>
  setProgramScene(sceneId: string, transition: AppState['transition']): Promise<void>
  setLayerVisible(sceneId: string, layerId: string, visible: boolean): Promise<void>
  setLayerText(sceneId: string, layerId: string, text: string): Promise<void>
  setVolume(sourceId: string, volume: number): Promise<void>
  setMuted(sourceId: string, muted: boolean): Promise<void>
  startStream(targets: StreamTarget[], preset: QualityPreset): Promise<void>
  stopStream(): Promise<void>
  startRecording(folder: string, format: 'mp4' | 'mkv', preset: QualityPreset): Promise<void>
  stopRecording(): Promise<void>
  readStats(): EngineStats
  /** Ask a platform whether it accepts this stream key, without sending any video. */
  checkStreamKey?(serverUrl: string, key: string): Promise<{ ok: boolean; message: string }>
  shutdown(): Promise<void>
  /** The page that draws the video reports which devices its browser can open. */
  setInputs?(inputs: AppState['inputs']): void
  /** Numbers from the page that draws the video (frames per second, audio levels). */
  report?(r: { fps: number; audioLevels: Record<string, number> }): void
  /** Set by the controller: called when a stream or recording stops by itself, with a plain-words reason. */
  onOutputStopped?: (kind: 'stream' | 'record', reason: string) => void
  /** Set by the controller: a message for the people running the show (for example, reconnecting). */
  onNotice?: (message: string) => void
}

/** Stream keys. Kept out of AppState so they are never sent to devices. */
export interface KeyStore {
  get(destinationId: string): string | undefined
  set(destinationId: string, key: string): void
  has(destinationId: string): boolean
}

/** Paired devices. Implemented by the control server's pairing manager. */
export interface DeviceAdmin {
  setPairingOpen(open: boolean): void
  newPairingCode(): void
  remove(deviceId: string): void
  setRole(deviceId: string, role: Role): void
}

export class MemoryKeyStore implements KeyStore {
  private keys = new Map<string, string>()
  get(id: string) {
    return this.keys.get(id)
  }
  set(id: string, key: string) {
    if (key) this.keys.set(id, key)
    else this.keys.delete(id)
  }
  has(id: string) {
    return this.keys.has(id)
  }
}

/** Saved shows (show files in a folder on this PC). `file` is a plain file name in that folder. */
export interface ShowStore {
  /** Where the show files are, in words for the person ("Documents\Streaming App Shows"). */
  readonly folder: string
  list(): { file: string; name: string; savedAt: number; scenes: number }[]
  read(file: string): unknown
  write(file: string, show: unknown): void
  remove(file: string): void
}

/** Shows kept in memory: practice mode, the mockup and tests. */
export class MemoryShowStore implements ShowStore {
  readonly folder = 'this practice session (not saved to disk)'
  private files = new Map<string, unknown>()
  list() {
    return [...this.files].map(([file, v]) => {
      const show = v as { name?: string; savedAt?: number; scenes?: { id: string }[] }
      return { file, name: show.name ?? file, savedAt: show.savedAt ?? 0, scenes: (show.scenes ?? []).filter((x) => x.id !== 'overlay').length }
    })
  }
  read(file: string) {
    if (!this.files.has(file)) throw new Error('That show file is gone')
    return structuredClone(this.files.get(file))
  }
  write(file: string, show: unknown) {
    this.files.set(file, structuredClone(show))
  }
  remove(file: string) {
    this.files.delete(file)
  }
}
