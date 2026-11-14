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
  shutdown(): Promise<void>
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
