/**
 * Saving to disk: the Setup (scenes, audio, platforms, settings), paired
 * devices, and stream keys.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppState } from '../shared/state'
import { ensureOverlay, showScenes } from '../shared/state'
import { cleanGrade, isNeutral } from '../shared/color'
import { defaultState } from '../core/defaults'
import type { KeyStore, ShowStore } from '../core/ports'
import { isShowFileName } from '../core/show'
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
type SavedSetup = Pick<AppState, 'setupName' | 'scenes' | 'transition' | 'audio' | 'color'> & {
  quality: AppState['stream']['quality']
  frameRate?: AppState['stream']['frameRate']
  destinations: AppState['stream']['destinations']
  overlayOn?: boolean
  recordFolder: string
  recordFormat: AppState['recording']['format']
  /** The devices seen last time, so a device whose id changed is found again by its name. */
  inputs?: AppState['inputs']
  /** The show file this layout came from, and whether it had changes not saved yet. */
  show?: AppState['show']
  /** Live data fields, so team names and the like are still there after a restart. */
  data?: AppState['data']
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
    const scenes = saved.scenes && showScenes(saved.scenes).length ? saved.scenes : base.scenes
    const first = showScenes(scenes)[0].id
    return ensureOverlay({
      ...base,
      setupName: saved.setupName ?? base.setupName,
      show: saved.show ?? base.show,
      data: saved.data ?? base.data,
      scenes,
      previewSceneId: first,
      programSceneId: first,
      // Always on: there is no Overlay button any more (scenes can hide it).
      overlayOn: true,
      transition: saved.transition ?? base.transition,
      ...(isNeutral(saved.color) ? {} : { color: cleanGrade(saved.color) }),
      inputs: saved.inputs ?? base.inputs,
      audio: (saved.audio ?? base.audio).map((a) => ({ ...a, syncOffsetMs: a.syncOffsetMs ?? 0, level: 0 })),
      stream: {
        ...base.stream,
        quality: saved.quality ?? base.stream.quality,
        frameRate: saved.frameRate ?? base.stream.frameRate,
        // Until the cameras are measured: the fixed choice, else 30/60.
        family: saved.frameRate === 'pal' ? 'pal' : base.stream.family,
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
    })
  }

  save(s: AppState) {
    const setup: SavedSetup = {
      setupName: s.setupName,
      scenes: s.scenes,
      overlayOn: s.overlayOn,
      transition: s.transition,
      ...(isNeutral(s.color) ? {} : { color: s.color }),
      audio: s.audio.map((a) => ({ ...a, level: 0 })),
      quality: s.stream.quality,
      frameRate: s.stream.frameRate,
      destinations: s.stream.destinations,
      recordFolder: s.recording.folder,
      recordFormat: s.recording.format,
      inputs: s.inputs,
      show: s.show,
      data: s.data
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

/**
 * Saved shows: one .show.json file each, in a folder the person can find and
 * copy (Documents\Streaming App Shows on Windows).
 */
export class ShowFolder implements ShowStore {
  constructor(readonly dir: string, readonly folder = dir) {}
  list() {
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter(isShowFileName)
    } catch {
      return []
    }
    const out: { file: string; name: string; savedAt: number; scenes: number }[] = []
    for (const file of names) {
      const show = readJson<{ name?: unknown; savedAt?: unknown; scenes?: unknown }>(join(this.dir, file))
      if (!show) continue
      let savedAt = typeof show.savedAt === 'number' ? show.savedAt : 0
      if (!savedAt) {
        try {
          savedAt = statSync(join(this.dir, file)).mtimeMs
        } catch {
          // keep 0
        }
      }
      const scenes = Array.isArray(show.scenes) ? show.scenes.filter((x) => x && x.id !== 'overlay' && !x.commercial).length : 0
      out.push({ file, name: typeof show.name === 'string' && show.name ? show.name : file.replace(/\.show\.json$/, ''), savedAt, scenes })
    }
    return out
  }
  read(file: string): unknown {
    if (!isShowFileName(file)) throw new Error('not a show file')
    try {
      return JSON.parse(readFileSync(join(this.dir, file), 'utf8'))
    } catch (e) {
      throw new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'the file is gone from the shows folder' : 'the file is damaged')
    }
  }
  write(file: string, show: unknown) {
    if (!isShowFileName(file)) throw new Error('not a show file')
    writeJson(join(this.dir, file), show)
  }
  remove(file: string) {
    if (!isShowFileName(file)) throw new Error('not a show file')
    rmSync(join(this.dir, file), { force: true })
  }
}

export const files = (dir: string) => ({
  setup: join(dir, 'setup.json'),
  devices: join(dir, 'devices.json'),
  keys: join(dir, 'stream-keys.json')
})
