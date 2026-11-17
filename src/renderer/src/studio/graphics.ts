/**
 * Graphics (network) sources: web pages from a gfx app on another computer,
 * drawn see-through over the cameras.
 *
 * The desktop version loads each page in a hidden window and sends us the
 * part of its picture that changed (desktop/graphics.cjs). Here those parts
 * are put together into one picture per page, which Live, Preview and the
 * scene cards draw like any other source. The web version can't load another
 * site's picture, so there the source shows nothing and says it needs the
 * desktop version.
 */
import { presetFor } from '../../../shared/presets'
import { GRAPHICS_SIZES, scenesOnAir, type AppState, type Layer } from '../../../shared/state'

export type GraphicsStatus = 'loading' | 'connected' | 'unreachable' | 'needs-desktop'

/** One changed part of a page's picture, as the desktop version sends it. */
export interface GraphicsFrame {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Size of the whole picture. */
  fw: number
  fh: number
  /** BGRA, premultiplied alpha. */
  data: Uint8Array
}

interface DesktopGraphics {
  sync(list: { id: string; url: string; width: number; height: number; fps: number; live?: boolean }[]): void
  reload(id: string): void
  onFrame(fn: (f: GraphicsFrame) => void): () => void
  onStatus(fn: (s: { id: string; status: GraphicsStatus }) => void): () => void
  onClear(fn: (s: { id: string }) => void): () => void
  /** Desktop versions from before sound came along don't have these. */
  onAudioOffer?(fn: (o: { id: string; req: number; sdp: string }) => void): () => void
  audioAnswer?(req: number, answer: { sdp?: string; error?: string }): void
}

/** The desktop version's helper, when this page runs in it. */
export function desktopGraphics(): DesktopGraphics | null {
  return ((globalThis as { desktopGraphics?: DesktopGraphics }).desktopGraphics ?? null) || null
}

type Rect = { x: number; y: number; w: number; h: number }

/** Which page a graphics source shows, at which size and frame rate. Sources with the same settings share one page. */
export function feedSpec(l: Layer, state: AppState): { key: string; url: string; width: number; height: number; fps: number } | null {
  if ((l.kind !== 'graphics' && l.kind !== 'browser') || !l.url || !/^https?:\/\//i.test(l.url.trim())) return null
  const size = GRAPHICS_SIZES[l.size ?? '1080p'] ?? GRAPHICS_SIZES['1080p']
  const fps = l.fps ?? presetFor(state.stream.quality, state.stream.family).fps
  const url = l.url.trim()
  return { key: `${url}|${size.width}x${size.height}|${fps}`, url, width: size.width, height: size.height, fps }
}

/**
 * Turn a BGRA premultiplied part into RGBA with plain alpha (what the 2D canvas
 * and the graphics card's pictures use). A fully see-through pixel stays 0,0,0,0.
 */
export function toRgba(src: Uint8Array, out: Uint8ClampedArray) {
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]
    if (a === 0) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0
    } else if (a === 255) {
      out[i] = src[i + 2]
      out[i + 1] = src[i + 1]
      out[i + 2] = src[i]
      out[i + 3] = 255
    } else {
      const k = 255 / a
      out[i] = src[i + 2] * k
      out[i + 1] = src[i + 1] * k
      out[i + 2] = src[i] * k
      out[i + 3] = a
    }
  }
}

/** One page's picture, built up from the parts that changed. */
export class GraphicsFeed {
  readonly canvas = document.createElement('canvas')
  status: GraphicsStatus = 'loading'
  /** True once the page's picture has arrived since it (re)loaded. */
  ready = false
  /** Goes up with every change, so the graphics card knows to copy it again. */
  version = 0
  /** The part changed since the graphics card last copied it. */
  dirty: Rect | null = null
  /** The page's sound (a video's), when it sends it. */
  audio: MediaStream | null = null
  pc: RTCPeerConnection | null = null

  constructor(
    readonly key: string,
    width: number,
    height: number
  ) {
    this.canvas.width = width
    this.canvas.height = height
  }

  private ctx() {
    return this.canvas.getContext('2d', { willReadFrequently: true })!
  }

  apply(f: GraphicsFrame) {
    if (f.fw !== this.canvas.width || f.fh !== this.canvas.height) {
      // The picture comes at another scale (Windows display scaling): follow it.
      this.canvas.width = f.fw
      this.canvas.height = f.fh
      this.ready = false
    }
    if (f.w <= 0 || f.h <= 0 || f.data.length < f.w * f.h * 4) return
    const img = new ImageData(f.w, f.h)
    toRgba(f.data, img.data)
    this.ctx().putImageData(img, f.x, f.y)
    // The desktop version sends the whole page first after each load, then only what changes.
    this.ready = true
    this.version++
    this.dirty = union(this.dirty, { x: f.x, y: f.y, w: f.w, h: f.h })
  }

  clear() {
    this.ctx().clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ready = false
    this.version++
    this.dirty = { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height }
  }
}

function union(a: Rect | null, b: Rect): Rect {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/**
 * All graphics pages the scenes use. One per page (url + size + frame rate),
 * however many sources show it. Also the place the source list reads each
 * source's status light from.
 */
export class GraphicsFeeds {
  private feeds = new Map<string, GraphicsFeed>()
  private listeners = new Set<() => void>()
  private offs: (() => void)[] = []
  private started = false
  /** Pages opened by the "Add source" form to check an address before adding it. */
  private checks = new Map<string, { url: string; width: number; height: number; fps: number }>()
  private wanted: { id: string; url: string; width: number; height: number; fps: number; live?: boolean }[] = []
  private lastSent = ''

  constructor(private readonly desktop: DesktopGraphics | null = desktopGraphics()) {}

  private start() {
    if (this.started || !this.desktop) return
    this.started = true
    this.offs.push(
      this.desktop.onFrame((f) => this.feeds.get(f.id)?.apply(f)),
      this.desktop.onStatus(({ id, status }) => {
        const feed = this.feeds.get(id)
        if (!feed || feed.status === status) return
        feed.status = status
        this.changed()
      }),
      this.desktop.onClear(({ id }) => this.feeds.get(id)?.clear())
    )
    if (this.desktop.onAudioOffer) this.offs.push(this.desktop.onAudioOffer((o) => void this.answerAudio(o)))
  }

  /** A page sends its sound: take it in (one connection per page; a new one replaces the old). */
  private async answerAudio(o: { id: string; req: number; sdp: string }) {
    const reply = (a: { sdp?: string; error?: string }) => this.desktop?.audioAnswer?.(o.req, a)
    const feed = this.feeds.get(o.id)
    if (!feed) return reply({ error: 'Not shown here' })
    try {
      feed.pc?.close()
      const pc = new RTCPeerConnection()
      feed.pc = pc
      pc.ontrack = (e) => {
        if (feed.pc !== pc) return
        feed.audio = e.streams[0] ?? new MediaStream([e.track])
        this.changed()
      }
      pc.onconnectionstatechange = () => {
        if (feed.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
          feed.audio = null
          feed.pc = null
          this.changed()
        }
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp })
      await pc.setLocalDescription(await pc.createAnswer())
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve()
        pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve())
        setTimeout(resolve, 2000)
      })
      reply({ sdp: pc.localDescription!.sdp })
    } catch (e) {
      reply({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** A source's sound from its page, when the page sends one. */
  audioFor(l: Layer, state: AppState): MediaStream | null {
    const spec = feedSpec(l, state)
    return (spec && this.feeds.get(spec.key)?.audio) || null
  }

  /** Open the pages the scenes use; close the rest. */
  sync(state: AppState) {
    this.lastState = state
    const specs = new Map<string, NonNullable<ReturnType<typeof feedSpec>>>()
    // Pages on the stream now (a shown source in a scene on air, or in the Overlay over it): the page is told, so it can play its animation then.
    const onAir = scenesOnAir(state)
    const live = new Set<string>()
    for (const scene of state.scenes) {
      for (const l of scene.layers) {
        const spec = feedSpec(l, state)
        if (!spec) continue
        specs.set(spec.key, spec)
        if (l.visible && onAir.has(scene.id)) live.add(spec.key)
      }
    }
    for (const [key, c] of this.checks) specs.set(key, { key, ...c })
    let changed = false
    for (const [key, spec] of specs) {
      if (this.feeds.has(key)) continue
      const feed = new GraphicsFeed(key, spec.width, spec.height)
      if (!this.desktop) feed.status = 'needs-desktop'
      this.feeds.set(key, feed)
      changed = true
    }
    for (const key of [...this.feeds.keys()]) {
      if (specs.has(key)) continue
      this.feeds.get(key)?.pc?.close()
      this.feeds.delete(key)
      changed = true
    }
    this.wanted = [...specs.values()].map((s) => ({ id: s.key, url: s.url, width: s.width, height: s.height, fps: s.fps, live: live.has(s.key) }))
    this.send()
    if (changed) this.changed()
  }

  private send() {
    if (!this.desktop) return
    this.start()
    const now = JSON.stringify(this.wanted)
    if (now === this.lastSent) return
    this.lastSent = now
    this.desktop.sync(this.wanted)
  }

  /** The picture to draw for a source, or null while there's nothing to show. */
  feedFor(l: Layer, state: AppState): GraphicsFeed | null {
    const spec = feedSpec(l, state)
    const feed = spec ? this.feeds.get(spec.key) : undefined
    return feed && feed.ready && feed.status === 'connected' ? feed : null
  }

  /** A source's status light. Null when it has no address yet. */
  statusOf(l: Layer, state: AppState): GraphicsStatus | null {
    const spec = feedSpec(l, state)
    if (!spec) return null
    if (!this.desktop) return 'needs-desktop'
    return this.feeds.get(spec.key)?.status ?? 'loading'
  }

  /** Load a page again (after a change to its design). */
  reloadKey(key: string) {
    if (!this.desktop) return
    const feed = this.feeds.get(key)
    if (feed) {
      feed.status = 'loading'
      feed.ready = false
      this.changed()
    }
    this.desktop.reload(key)
  }

  /**
   * Open an address before it is added as a source, so the "Add source" form can
   * show what it shows. Returns its picture, and a function to close it again.
   */
  check(url: string, width: number, height: number, fps: number, state: AppState): { feed: GraphicsFeed | null; close: () => void } {
    const trimmed = url.trim()
    if (!/^https?:\/\//i.test(trimmed)) return { feed: null, close: () => {} }
    const key = `${trimmed}|${width}x${height}|${fps}`
    this.checks.set(key, { url: trimmed, width, height, fps })
    this.sync(state)
    return {
      feed: this.feeds.get(key) ?? null,
      close: () => {
        this.checks.delete(key)
        if (this.lastState) this.sync(this.lastState)
      }
    }
  }

  private lastState: AppState | null = null

  /** The check page for an address, for its status and picture. */
  feedByKey(key: string): GraphicsFeed | null {
    return this.feeds.get(key) ?? null
  }

  get available() {
    return !!this.desktop
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Goes up with every status change (for React's useSyncExternalStore). */
  version = 0

  private changed() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  close() {
    this.offs.forEach((off) => off())
    this.offs = []
    this.started = false
    for (const f of this.feeds.values()) f.pc?.close()
    this.feeds.clear()
    this.wanted = []
    this.lastSent = ''
    this.desktop?.sync([])
  }
}

/**
 * The studio's graphics pages. One per window: the source list reads the status
 * lights from it, and the compositor draws from it.
 */
export const graphicsFeeds = new GraphicsFeeds()
