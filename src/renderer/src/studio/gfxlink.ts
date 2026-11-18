/**
 * What the streaming app sends back to the gfx apps it shows (desktop version):
 *
 * - Cue to stream: a gfx app cued a commercial. Copy the video here, fill the
 *   Commercial scene with it and put it in Preview; then tell the gfx app how it
 *   goes (copying, cued, onair with its time, done), until it has played.
 * - The Live picture: a small JPEG a few times a second, for the gfx operator's
 *   On air screen.
 */
import type { AppState } from '../../../shared/state'
import type { Bridge } from '../bridge/bridge'

interface CueMsg {
  origin: string
  take: number
  /** The break's videos, in play order. */
  items?: { name: string; url: string }[]
  clear?: boolean
  /** The break is on air and got longer: add to it as it plays. */
  onAir?: boolean
}
interface LinkDesktop {
  onCue(fn: (c: CueMsg) => void): () => void
  copyCue(url: string): Promise<string>
  post(origin: string, path: '/api/cue' | '/api/program', body: unknown): void
}
const linkDesktop = (): LinkDesktop | null => {
  const d = (globalThis as { desktopGraphics?: Partial<LinkDesktop> }).desktopGraphics
  return d?.onCue && d.copyCue && d.post ? (d as LinkDesktop) : null
}

/** The gfx apps shown now: the origins of the Graphics (network) sources' pages. */
function gfxOrigins(state: AppState): string[] {
  const out = new Set<string>()
  for (const l of state.scenes.flatMap((s) => s.layers)) {
    if (l.kind !== 'graphics' || !l.url) continue
    try {
      out.add(new URL(/^https?:\/\//i.test(l.url) ? l.url : `http://${l.url}`).origin)
    } catch {
      // not an address yet
    }
  }
  return [...out]
}

const PICTURE_W = 640
const PICTURE_H = 360
const PICTURE_FPS = 5

export class GfxLink {
  private readonly desk = linkDesktop()
  private offCue: (() => void) | null = null
  private pictureTimer: ReturnType<typeof setInterval> | null = null
  private statusTimer: ReturnType<typeof setInterval> | null = null
  private small = document.createElement('canvas')
  /** A break on air is getting longer (followCue waits until that is done). */
  private extending = false
  /** The cue being handled: where it came from, and the file it was copied to. */
  private cue: { origin: string; take: number; paths: string[]; status: string } | null = null
  private seen = new Set<string>()
  /** The newest take seen from each gfx app. */
  private latest = new Map<string, number>()

  constructor(
    private readonly bridge: Bridge,
    private readonly getState: () => AppState | null,
    private readonly drawLive: (canvas: HTMLCanvasElement) => boolean,
    private readonly mediaElement: (url: string) => HTMLVideoElement | null,
    private readonly notice: (m: string) => void
  ) {}

  get available() {
    return !!this.desk
  }

  start() {
    if (!this.desk) return
    this.offCue = this.desk.onCue((c) => void this.onCue(c))
    this.small.width = PICTURE_W
    this.small.height = PICTURE_H
    this.pictureTimer = setInterval(() => this.sendPicture(), 1000 / PICTURE_FPS)
    this.statusTimer = setInterval(() => this.followCue(), 500)
  }

  stop() {
    this.offCue?.()
    if (this.pictureTimer) clearInterval(this.pictureTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
  }

  private tell(origin: string, take: number, status: string, more: Record<string, unknown> = {}) {
    this.desk?.post(origin, '/api/cue', { take, status, ...more })
  }

  private async onCue(c: CueMsg) {
    const key = `${c.origin}|${c.take}|${c.clear ? 'clear' : 'cue'}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (c.clear) {
      if (this.cue?.origin === c.origin && this.cue.take === c.take && this.cue.status !== 'onair') {
        this.cue = null
        await this.bridge.command('cue.clear', {}).catch(() => {})
        this.notice('The gfx app took its commercial back.')
      }
      return
    }
    if (!c.items?.length || !this.desk) return
    // A newer take from the same gfx app (the break changed while copying) wins over this one.
    this.latest.set(c.origin, c.take)
    const stale = () => (this.latest.get(c.origin) ?? 0) > c.take
    if (c.onAir) return this.extendBreak(c, stale)
    const n = c.items.length
    const name = n === 1 ? `“${c.items[0].name || 'Commercial'}”` : `a break of ${n} commercials`
    this.tell(c.origin, c.take, 'copying')
    try {
      const items: { name: string; path: string }[] = []
      for (const it of c.items) items.push({ name: it.name || 'Commercial', path: await this.desk.copyCue(it.url) })
      if (stale()) return
      const r = await this.bridge.command('cue.commercial', { items })
      if (!r.ok) throw new Error(r.error ?? 'Could not cue it')
      this.cue = { origin: c.origin, take: c.take, paths: items.map((x) => x.path), status: 'cued' }
      this.tell(c.origin, c.take, 'cued')
      this.notice(`The gfx app cued ${name}. It’s in Preview: press Transition to play ${n === 1 ? 'it' : 'them, one after the other'}.`)
    } catch (e) {
      if (stale()) return
      const why = e instanceof Error ? e.message : String(e)
      this.tell(c.origin, c.take, 'failed', { error: why })
      this.notice(`The gfx app cued “${name}”, but it could not be copied here: ${why}`)
    }
  }

  /** The gfx operator added to (or changed what's still to come in) the break on air: take the new list in. */
  private async extendBreak(c: CueMsg, stale: () => boolean) {
    const cue = this.cue
    if (!cue || cue.origin !== c.origin || cue.status !== 'onair' || !c.items || !this.desk) {
      // Too late: the break has ended (or it isn't this app's).
      this.tell(c.origin, c.take, 'failed', { error: 'the break had ended' })
      return
    }
    try {
      const items: { name: string; path: string }[] = []
      for (const it of c.items) items.push({ name: it.name || 'Commercial', path: await this.desk.copyCue(it.url) })
      if (stale() || this.cue !== cue || cue.status !== 'onair') return
      this.extending = true
      const r = await this.bridge.command('cue.commercial', { items, extend: true })
      if (!r.ok) throw new Error(r.error ?? 'Could not add to the break')
      this.cue = { origin: c.origin, take: c.take, paths: items.map((x) => x.path), status: 'onair' }
      this.notice(`The gfx app changed the break on air: ${items.length} commercials now.`)
    } catch (e) {
      if (stale()) return
      this.tell(c.origin, c.take, 'failed', { error: e instanceof Error ? e.message : String(e) })
    } finally {
      this.extending = false
    }
  }

  /** While the cued commercial is in Preview, on air, and after: tell the gfx app. */
  private followCue() {
    const cue = this.cue
    const st = this.getState()
    if (!cue || !st || this.extending) return
    const scene = st.scenes.find((s) => s.commercial)
    const media = scene?.layers.filter((l) => l.kind === 'media') ?? []
    const ours = media.length === cue.paths.length && media.every((l, i) => l.url === cue.paths[i])
    if (!scene || !ours) {
      // Replaced or emptied here.
      if (cue.status !== 'onair') this.tell(cue.origin, cue.take, 'cleared')
      else this.tell(cue.origin, cue.take, 'done')
      this.cue = null
      return
    }
    const live = st.programSceneId === scene.id
    if (live) {
      cue.status = 'onair'
      // Which video of the break plays, its time, and the time left in the whole break.
      const at = Math.max(0, media.findIndex((l) => l.visible))
      const dur = (p: string | undefined) => {
        const d = p ? this.mediaElement(p)?.duration : 0
        return d && Number.isFinite(d) ? d : 0
      }
      const el = this.mediaElement(cue.paths[at])
      const pos = el?.currentTime ?? 0
      const left = Math.max(0, dur(cue.paths[at]) - pos) + cue.paths.slice(at + 1).reduce((t, p) => t + dur(p), 0)
      this.tell(cue.origin, cue.take, 'onair', { at, pos, dur: dur(cue.paths[at]), left })
    } else if (cue.status === 'onair') {
      this.tell(cue.origin, cue.take, 'done')
      this.cue = null
    }
  }

  /** A small copy of the Live picture to each gfx app shown (for its On air screen). */
  private sendPicture() {
    const st = this.getState()
    if (!st || !this.desk || document.visibilityState === 'hidden') return
    const origins = gfxOrigins(st)
    if (!origins.length) return
    try {
      if (!this.drawLive(this.small)) return
    } catch {
      return
    }
    this.small.toBlob(
      (blob) => {
        if (!blob) return
        void blob.arrayBuffer().then((buf) => {
          const bytes = new Uint8Array(buf)
          for (const o of origins) this.desk?.post(o, '/api/program', bytes)
        })
      },
      'image/jpeg',
      0.6
    )
  }
}
