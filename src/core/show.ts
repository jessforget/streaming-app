/**
 * Show files: a show's standard layout (scenes, the Overlay, sources, the
 * sound mixer, live data fields, platforms and quality), saved to a file and
 * opened again for the next show. Stream keys are never in a show file: they
 * stay in this PC's own key file.
 */
import { CommandError, type DataValue } from '../shared/protocol'
import { ensureOverlay, showScenes, type AppState, type AudioSource, type InputDevice, type Scene } from '../shared/state'

export const SHOW_FORMAT = 'streaming-app-show'
export const SHOW_VERSION = 1

export interface ShowFile {
  format: typeof SHOW_FORMAT
  version: number
  name: string
  /** When it was saved (milliseconds since 1970). */
  savedAt: number
  scenes: Scene[]
  transition: AppState['transition']
  audio: AudioSource[]
  quality: AppState['stream']['quality']
  frameRate: AppState['stream']['frameRate']
  /** Which platforms are on, and their server addresses. Never the stream keys. */
  destinations: { id: string; enabled: boolean; vertical: boolean; serverUrl?: string }[]
  recordFolder: string
  recordFormat: AppState['recording']['format']
  /** Live data fields and their values when saved (team names, the guest's name...). */
  data: Record<string, DataValue>
  /** The devices the show used, by name, so they are found again on another PC (or after their ids change). */
  devices: { video: Pick<InputDevice, 'id' | 'name'>[]; audio: Pick<InputDevice, 'id' | 'name'>[] }
}

/** One saved show, as the Open show list shows it. */
export interface ShowSummary {
  file: string
  name: string
  savedAt: number
  scenes: number
}

/** A show's scenes, minus the gfx app's commercial scene (it is made again on the next cue). */
function keptScenes(scenes: Scene[]): Scene[] {
  return scenes.filter((s) => !s.commercial)
}

/** The show part of the state, as it goes into a show file. */
export function showFromState(s: AppState, name: string, savedAt: number): ShowFile {
  const scenes = structuredClone(keptScenes(s.scenes))
  const ids = new Set(scenes.map((x) => x.id))
  const used = new Set([...s.audio.map((a) => a.device), ...scenes.flatMap((x) => x.layers.map((l) => l.device))])
  const named = (list: InputDevice[]) => list.filter((d) => used.has(d.id)).map((d) => ({ id: d.id, name: d.name }))
  return {
    format: SHOW_FORMAT,
    version: SHOW_VERSION,
    name,
    savedAt,
    scenes,
    transition: { ...s.transition },
    audio: s.audio.map((a) => {
      const copy: AudioSource = { ...a, level: 0 }
      if (copy.scenes) copy.scenes = copy.scenes.filter((id) => ids.has(id))
      if (copy.scenes && !copy.scenes.length) delete copy.scenes
      return copy
    }),
    quality: s.stream.quality,
    frameRate: s.stream.frameRate,
    destinations: s.stream.destinations.map((d) => ({ id: d.id, enabled: d.enabled, vertical: d.vertical, ...(d.serverUrl ? { serverUrl: d.serverUrl } : {}) })),
    recordFolder: s.recording.folder,
    recordFormat: s.recording.format,
    data: Object.fromEntries(Object.entries(s.data).map(([k, f]) => [k, f.value])),
    devices: { video: named(s.inputs.video), audio: named(s.inputs.audio) }
  }
}

/**
 * What decides "changes not saved yet": the layout, not things that move
 * during a show (live data values, which scene is on air, sound levels).
 */
export function showFingerprint(s: AppState): string {
  const show = showFromState(s, '', 0)
  return JSON.stringify([show.scenes, show.transition, show.audio, show.quality, show.frameRate, show.destinations, show.recordFolder, show.recordFormat])
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Check a show file read from disk or loaded from another PC. Throws a plain-words error. */
export function readShow(raw: unknown): ShowFile {
  const bad = (why: string) => new CommandError(`This isn’t a project file the app can open (${why}).`)
  if (!isObj(raw) || raw.format !== SHOW_FORMAT) throw bad('it was not saved by this app')
  if (typeof raw.version !== 'number' || raw.version > SHOW_VERSION) throw new CommandError('This project was saved by a newer version of the app. Update the app to open it.')
  if (!Array.isArray(raw.scenes) || !raw.scenes.every((x) => isObj(x) && typeof x.id === 'string' && typeof x.name === 'string' && Array.isArray(x.layers))) throw bad('its scenes are damaged')
  if (!showScenes(raw.scenes as Scene[]).length) throw bad('it has no scenes')
  if (!Array.isArray(raw.audio) || !raw.audio.every((a) => isObj(a) && typeof a.id === 'string' && typeof a.kind === 'string')) throw bad('its sound mixer is damaged')
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Show'
  const devices = isObj(raw.devices) ? raw.devices : {}
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((d) => isObj(d) && typeof d.id === 'string' && typeof d.name === 'string') : []) as InputDevice[]
  const data: Record<string, DataValue> = {}
  if (isObj(raw.data)) {
    for (const [k, v] of Object.entries(raw.data)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) data[k] = v as DataValue
  }
  return {
    format: SHOW_FORMAT,
    version: raw.version,
    name,
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
    scenes: raw.scenes as Scene[],
    transition: isObj(raw.transition) && (raw.transition.kind === 'cut' || raw.transition.kind === 'fade') ? (raw.transition as AppState['transition']) : { kind: 'fade', durationMs: 500 },
    audio: raw.audio as AudioSource[],
    quality: raw.quality === 'low' || raw.quality === 'medium' || raw.quality === 'high' ? raw.quality : 'low',
    frameRate: raw.frameRate === 'pal' || raw.frameRate === 'ntsc' ? raw.frameRate : 'auto',
    destinations: Array.isArray(raw.destinations) ? (raw.destinations.filter((d) => isObj(d) && typeof d.id === 'string') as ShowFile['destinations']) : [],
    recordFolder: typeof raw.recordFolder === 'string' ? raw.recordFolder : '',
    recordFormat: raw.recordFormat === 'mkv' ? 'mkv' : 'mp4',
    data,
    devices: { video: list(devices.video), audio: list(devices.audio) }
  }
}

/**
 * Put a show into the state (changes `s`). The devices this PC can see stay as
 * they are; a device the show used is found again by its name when its id
 * differs here. Stream keys and paired devices are not touched.
 */
export function applyShow(s: AppState, show: ShowFile, now: number): void {
  const scenes = structuredClone(keptScenes(show.scenes))
  // Follow devices by name: another PC, or a browser that gave them new ids.
  const here = s.inputs
  for (const kind of ['video', 'audio'] as const) {
    for (const old of show.devices[kind]) {
      if (here[kind].some((d) => d.id === old.id)) continue
      const twins = here[kind].filter((d) => d.name === old.name)
      if (twins.length !== 1) continue
      const id = twins[0].id
      for (const scene of scenes) for (const l of scene.layers) if (l.device === old.id) l.device = id
      for (const a of show.audio) if (a.device === old.id) a.device = id
    }
  }
  s.setupName = show.name
  s.scenes = scenes
  ensureOverlay(s)
  const first = showScenes(s.scenes).find((x) => !x.stored) ?? showScenes(s.scenes)[0]
  s.previewSceneId = first.id
  s.programSceneId = first.id
  s.transition = { ...show.transition }
  s.audio = structuredClone(show.audio).map((a) => ({ ...a, syncOffsetMs: a.syncOffsetMs ?? 0, volume: a.volume ?? 1, muted: !!a.muted, level: 0 }))
  s.stream.quality = show.quality
  s.stream.frameRate = show.frameRate
  s.stream.destinations = s.stream.destinations.map((d) => {
    const saved = show.destinations.find((x) => x.id === d.id)
    if (!saved) return { ...d, enabled: false }
    return { ...d, enabled: !!saved.enabled && d.hasKey, vertical: typeof saved.vertical === 'boolean' ? saved.vertical : d.vertical, ...(saved.serverUrl !== undefined ? { serverUrl: saved.serverUrl } : {}) }
  })
  if (show.recordFolder) s.recording.folder = show.recordFolder
  s.recording.format = show.recordFormat
  s.data = Object.fromEntries(Object.entries(show.data).map(([k, value]) => [k, { value, updatedAt: now, source: 'Show file' }]))
}

/** A file name for a show: its name, without characters Windows won't take. */
export function showFileName(name: string): string {
  const base =
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 60) || 'Show'
  return `${base}.show.json`
}

/** Only plain file names in the shows folder, never a path elsewhere on the PC. */
export function isShowFileName(file: unknown): file is string {
  return typeof file === 'string' && /^[^<>:"/\\|?*\u0000-\u001f]{1,80}\.show\.json$/.test(file) && !file.startsWith('.')
}
