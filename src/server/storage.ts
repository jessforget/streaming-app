/**
 * Saving to disk: the Setup (scenes, audio, platforms, settings), paired
 * devices, and stream keys.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

function writeJson(file: string, value: unknown, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode })
  renameSync(tmp, file)
}

/** The parts of the state worth keeping between sessions. */
type SavedSetup = Pick<AppState, 'setupName' | 'scenes' | 'transition' | 'audio'> & {
  quality: AppState['stream']['quality']
  destinations: AppState['stream']['destinations']
  recordFolder: string
  recordFormat: AppState['recording']['format']
  /** The devices seen last time, so a device whose id changed is found again by its name. */
  inputs?: AppState['inputs']
}

export class SetupFile {
  constructor(
    private readonly file: string,
    private readonly fresh: () => AppState = defaultState
  ) {}

  load(): AppState {
    const base = this.fresh()
    const saved = readJson<Partial<SavedSetup>>(this.file)
    if (!saved) return base
    return {
      ...base,
      setupName: saved.setupName ?? base.setupName,
      scenes: saved.scenes?.length ? saved.scenes : base.scenes,
      previewSceneId: (saved.scenes?.[0] ?? base.scenes[0]).id,
      programSceneId: (saved.scenes?.[0] ?? base.scenes[0]).id,
      transition: saved.transition ?? base.transition,
      inputs: saved.inputs ?? base.inputs,
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
      recordFormat: s.recording.format,
      inputs: s.inputs
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

/**
 * Stream keys, saved in a file only this Windows user can read. The web
 * version keeps them as plain text there; the desktop version will encrypt
 * them with Windows' own protection (DPAPI).
 */
export class FileKeyStore implements KeyStore {
  private keys = new Map<string, string>()

  constructor(private readonly file: string) {
    const saved = readJson<Record<string, string>>(file) ?? {}
    for (const [id, key] of Object.entries(saved)) if (typeof key === 'string' && key) this.keys.set(id, key)
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
    writeJson(this.file, Object.fromEntries(this.keys), 0o600)
  }
}

export const files = (dir: string) => ({
  setup: join(dir, 'setup.json'),
  devices: join(dir, 'devices.json'),
  keys: join(dir, 'stream-keys.json')
})
