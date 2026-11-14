/**
 * Saving to disk: the Setup (scenes, audio, platforms, settings), paired
 * devices, and stream keys. Stream keys are encrypted with the operating
 * system's protection (Windows DPAPI via Electron safeStorage) when available.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppState } from '../shared/state'
import { defaultState } from '../core/defaults'
import type { KeyStore } from '../core/ports'
import type { DeviceStore, StoredDevice } from './control/pairing'

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

/** The parts of the state worth keeping between sessions. */
type SavedSetup = Pick<AppState, 'setupName' | 'scenes' | 'transition' | 'audio'> & {
  quality: AppState['stream']['quality']
  destinations: AppState['stream']['destinations']
  recordFolder: string
  recordFormat: AppState['recording']['format']
}

export class SetupFile {
  constructor(private readonly file: string) {}

  load(): AppState {
    const base = defaultState()
    const saved = readJson<Partial<SavedSetup>>(this.file)
    if (!saved) return base
    return {
      ...base,
      setupName: saved.setupName ?? base.setupName,
      scenes: saved.scenes?.length ? saved.scenes : base.scenes,
      previewSceneId: (saved.scenes?.[0] ?? base.scenes[0]).id,
      programSceneId: (saved.scenes?.[0] ?? base.scenes[0]).id,
      transition: saved.transition ?? base.transition,
      audio: (saved.audio ?? base.audio).map((a) => ({ ...a, syncOffsetMs: a.syncOffsetMs ?? 0, level: 0 })),
      stream: {
        ...base.stream,
        quality: saved.quality ?? base.stream.quality,
        destinations: base.stream.destinations.map((d) => ({
          ...d,
          ...saved.destinations?.find((x) => x.id === d.id)
        }))
      },
      recording: {
        ...base.recording,
        folder: saved.recordFolder ?? base.recording.folder,
        format: saved.recordFormat ?? base.recording.format
      },
    }
  }

  save(s: AppState) {
    const setup: SavedSetup = {
      setupName: s.setupName,
      scenes: s.scenes,
      transition: s.transition,
      audio: s.audio.map((a) => ({ ...a, level: 0 })),
      quality: s.stream.quality,
      destinations: s.stream.destinations,
      recordFolder: s.recording.folder,
      recordFormat: s.recording.format
    }
    writeJson(this.file, setup)
  }
}

export class DeviceFile implements DeviceStore {
  constructor(private readonly file: string) {}
  load(): StoredDevice[] {
    return readJson<StoredDevice[]>(this.file) ?? []
  }
  save(devices: StoredDevice[]) {
    writeJson(this.file, devices)
  }
}

export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

/** Stream keys, encrypted at rest. If the OS offers no encryption, keys live in memory only. */
export class EncryptedKeyStore implements KeyStore {
  private keys = new Map<string, string>()

  constructor(
    private readonly file: string,
    private readonly crypto: Encryptor
  ) {
    if (!crypto.isEncryptionAvailable() || !existsSync(file)) return
    const saved = readJson<Record<string, string>>(file) ?? {}
    for (const [id, b64] of Object.entries(saved)) {
      try {
        this.keys.set(id, crypto.decryptString(Buffer.from(b64, 'base64')))
      } catch {
        // unreadable (another user or machine): ignore, the user re-enters it
      }
    }
  }

  get(id: string) {
    return this.keys.get(id)
  }
  has(id: string) {
    return this.keys.has(id)
  }
  set(id: string, key: string) {
    if (key) this.keys.set(id, key)
    else this.keys.delete(id)
    if (!this.crypto.isEncryptionAvailable()) return
    const out: Record<string, string> = {}
    for (const [k, v] of this.keys) out[k] = this.crypto.encryptString(v).toString('base64')
    writeJson(this.file, out)
  }
}

export const files = (dir: string) => ({
  setup: join(dir, 'setup.json'),
  devices: join(dir, 'devices.json'),
  keys: join(dir, 'stream-keys.json')
})
