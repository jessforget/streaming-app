/**
 * Draws the scenes, live, on canvases: the Live picture (what goes out) at
 * full quality, and the Preview picture smaller. Sources are drawn back to
 * front: the bottom of the source list first, the top last (in front).
 */
import { presetFor } from '../../../shared/presets'
import { renderTemplate } from '../../../shared/template'
import { countdownText, overlayOver, placementOf, scenesOnAir, type AppState, type Layer, type Placement, type Scene } from '../../../shared/state'
import { graphicsFeeds } from './graphics'
import { NET_PREFIX } from './netcams'
import { PHONE_PREFIX } from './phones'

/** Phones and network cameras: their video comes over the network, not from a device on this PC. */
const linked = (id: string) => id.startsWith(PHONE_PREFIX) || id.startsWith(NET_PREFIX)

/** A phone's tracks belong to its connection; stopping them would end the phone's camera for good. */
const stopTracks = (id: string, stream?: MediaStream) => {
  if (!linked(id)) stream?.getTracks().forEach((t) => t.stop())
}

type Drawable = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement

/** The address the browser loads a picture or video file from: through the app, for files on this PC. */
export function fileUrl(path: string): string {
  return /^https?:\/\//i.test(path) ? path : `/files?path=${encodeURIComponent(path)}`
}

export class Compositor {
  readonly program = document.createElement('canvas')
  readonly preview = document.createElement('canvas')
  protected state: AppState | null = null
  private videos = new Map<string, { el: HTMLVideoElement; stream?: MediaStream; failed?: boolean }>()
  private images = new Map<string, HTMLImageElement>()
  /** Screen and window sources, once the person picked what to share. */
  private displays = new Map<string, HTMLVideoElement>()
  private shownProgram = ''
  protected fadeFrom: { scene: Scene; start: number; ms: number } | null = null
  /** Sources that need a click to start (screen and window capture). */
  readonly waiting = new Set<string>()
  /** Video devices that could not be opened, with the reason. */
  readonly problems = new Map<string, string>()
  /** Where phone cameras come from (set by the studio). */
  phoneStream: (id: string) => MediaStream | null = () => null
  /** Slideshow folders: their pictures, once listed. */
  private folders = new Map<string, HTMLImageElement[]>()
  /** When each scene last went on air (for countdowns in minutes). */
  protected liveAt = new Map<string, number>()
  private onAir = new Set<string>()
  /** Graphics (network) pages: shared with the source list, which shows their status lights. */
  readonly graphics = graphicsFeeds

  /**
   * A capture device on this PC that is open: the frame rate it runs at, and the most it can do
   * (an ATEM set to 1080p25 can't do more than 25). Null if it isn't open.
   */
  deviceRate(id: string): { fps: number; max: number } | null {
    if (linked(id)) return null
    const track = this.videos.get(id)?.stream?.getVideoTracks()[0]
    if (!track || track.readyState !== 'live') return null
    const fps = track.getSettings().frameRate ?? 0
    const max = (track.getCapabilities?.().frameRate as { max?: number } | undefined)?.max ?? fps
    return fps > 0 ? { fps, max } : null
  }

  /** The playing element of a video file, for its sound. */
  mediaElement(url: string): HTMLVideoElement | null {
    return this.videos.get(`media:${url}`)?.el ?? null
  }

  /** Which way Live and Preview are drawn: the processor's 2D canvas, or the graphics card (GpuCompositor). */
  readonly renderer: 'canvas' | 'gpu' = 'canvas'

  constructor(gpu = false) {
    if (gpu) this.renderer = 'gpu'
    else {
      // No see-through: the browser can skip blending the canvases, which is cheaper for every frame.
      this.program.getContext('2d', { alpha: false })
      this.preview.getContext('2d', { alpha: false })
    }
    this.setSize(1920, 1080)
  }

  setSize(w: number, h: number) {
    if (this.program.width !== w || this.program.height !== h) {
      this.program.width = w
      this.program.height = h
    }
    // Preview is shown as big as Live, so it gets a sharper picture (still drawn every other frame).
    this.preview.width = 960
    this.preview.height = Math.round((960 * h) / w)
  }

  update(state: AppState) {
    const before = this.state
    this.state = state
    if (before && state.programSceneId !== this.shownProgram) {
      const old = before.scenes.find((s) => s.id === this.shownProgram)
      if (old && state.transition.kind === 'fade' && state.transition.durationMs > 0) {
        this.fadeFrom = { scene: old, start: performance.now(), ms: state.transition.durationMs }
      }
    }
    this.shownProgram = state.programSceneId
    this.syncSources(state)
    // The frame rate changed (25 <-> 30): ask the cameras on this PC for the new one, where they can.
    const fps = presetFor(state.stream.quality, state.stream.family).fps
    if (before && presetFor(before.stream.quality, before.stream.family).fps !== fps) {
      for (const [id, v] of this.videos) {
        if (linked(id) || id.startsWith('media:')) continue
        void v.stream?.getVideoTracks()[0]?.applyConstraints({ frameRate: { ideal: fps } }).catch(() => {})
      }
    }
    // Scenes that just went on air: start their countdowns, and play their one-shot videos from the top.
    const onAir = scenesOnAir(state)
    for (const id of onAir) {
      if (this.onAir.has(id)) continue
      this.liveAt.set(id, Date.now())
      for (const l of state.scenes.find((x) => x.id === id)?.layers ?? []) {
        const el = l.kind === 'media' && l.url && l.loop === false ? this.videos.get(`media:${l.url}`)?.el : undefined
        if (el) {
          clearTimeout(this.rewind.get(el))
          el.currentTime = 0
          void el.play().catch(() => {})
        }
      }
    }
    this.onAir = onAir
    // One-shot videos no longer on air: once the fade is over, stop and wait on the first frame for next time.
    const fadeMs = state.transition.kind === 'fade' ? state.transition.durationMs : 0
    for (const [key, v] of this.videos) {
      if (!key.startsWith('media:') || v.el.loop) continue
      const url = key.slice('media:'.length)
      const live = state.scenes.some((s) => onAir.has(s.id) && s.layers.some((l) => l.kind === 'media' && l.url === url && l.visible))
      if (live || v.el.paused || this.rewind.has(v.el)) continue
      this.rewind.set(
        v.el,
        window.setTimeout(() => {
          this.rewind.delete(v.el)
          if (!this.state || this.state.scenes.some((s) => this.onAir.has(s.id) && s.layers.some((l) => l.kind === 'media' && l.url === url && l.visible))) return
          v.el.pause()
          v.el.currentTime = 0
        }, fadeMs + 300)
      )
    }
  }

  /** Waiting to stop a one-shot video that left the air (after the fade). */
  private rewind = new Map<HTMLVideoElement, number>()
  /** A one-shot video reached its end (set by the studio: it may go back to the scene before). */
  onMediaEnded: (url: string) => void = () => {}

  /** Open every capture device used in any scene; close the rest. */
  private syncSources(state: AppState) {
    const devices = new Set<string>()
    const files = new Set<string>()
    this.waiting.clear()
    for (const scene of state.scenes) {
      for (const l of scene.layers) {
        if (l.kind === 'video' && l.device) devices.add(l.device)
        if ((l.kind === 'image' || l.kind === 'media') && l.url) files.add(`${l.kind}:${l.url}`)
        if (l.kind === 'slideshow' && l.url && !this.folders.has(l.url)) this.loadFolder(l.url)
        if ((l.kind === 'screen' || l.kind === 'window') && !this.displays.has(l.id)) this.waiting.add(l.id)
      }
    }
    this.graphics.sync(state)
    for (const id of devices) if (!this.videos.has(id)) this.openDevice(id, state)
    for (const [id, v] of this.videos) {
      if (!id.startsWith('media:') && !devices.has(id)) {
        stopTracks(id, v.stream)
        this.videos.delete(id)
        this.problems.delete(id)
      }
    }
    for (const key of files) {
      const [kind, url] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
      if (kind === 'image' && !this.images.has(url)) {
        const img = new Image()
        img.src = fileUrl(url)
        this.images.set(url, img)
      }
      if (kind === 'media' && !this.videos.has(`media:${url}`)) {
        const el = document.createElement('video')
        // A one-shot (auto-play) video waits on its first frame until its scene goes live.
        const once = state.scenes.every((s) => s.layers.every((l) => !(l.kind === 'media' && l.url === url) || l.loop === false))
        Object.assign(el, { src: fileUrl(url), loop: !once, muted: true, playsInline: true, preload: 'auto' })
        if (!once) void el.play().catch(() => {})
        el.addEventListener('ended', () => this.onMediaEnded(url))
        this.videos.set(`media:${url}`, { el })
      }
    }
    // Loop unless every source using that file says play once.
    for (const [key, v] of this.videos) {
      if (!key.startsWith('media:')) continue
      const url = key.slice('media:'.length)
      const layers = state.scenes.flatMap((x) => x.layers).filter((l) => l.kind === 'media' && l.url === url)
      if (layers.length === 0) {
        v.el.pause()
        v.el.removeAttribute('src')
        this.videos.delete(key)
        continue
      }
      const loop = layers.some((l) => l.loop !== false)
      // Switched to looping: start it; the auto-play ones start when their scene goes live.
      if (loop && !v.el.loop) void v.el.play().catch(() => {})
      v.el.loop = loop
    }
  }

  /** List a slideshow folder's pictures (through the app) and load them. */
  private loadFolder(dir: string) {
    this.folders.set(dir, [])
    fetch(`/api/folder?path=${encodeURIComponent(dir)}`)
      .then((r) => r.json() as Promise<{ files?: string[] }>)
      .then((b) => {
        this.folders.set(
          dir,
          (b.files ?? []).map((f) => {
            const img = new Image()
            img.src = fileUrl(f)
            return img
          })
        )
      })
      .catch(() => {})
  }

  private openDevice(id: string, state: AppState) {
    const el = document.createElement('video')
    Object.assign(el, { muted: true, playsInline: true, autoplay: true })
    const entry: { el: HTMLVideoElement; stream?: MediaStream; failed?: boolean } = { el }
    this.videos.set(id, entry)
    if (linked(id)) {
      const stream = this.phoneStream(id)
      if (!stream) {
        entry.failed = true
        this.problems.set(id, id.startsWith(NET_PREFIX) ? 'Network camera not connected' : 'Phone not connected')
        return
      }
      entry.stream = stream
      el.srcObject = stream
      void el.play().catch(() => {})
      this.problems.delete(id)
      return
    }
    const fps = presetFor(state.stream.quality, state.stream.family).fps
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: id }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: fps } } })
      .then((stream) => {
        if (this.videos.get(id) !== entry) return stream.getTracks().forEach((t) => t.stop())
        entry.stream = stream
        el.srcObject = stream
        void el.play().catch(() => {})
        this.problems.delete(id)
        stream.getVideoTracks()[0]?.addEventListener('ended', () => {
          // Unplugged: forget it so plugging back in reopens it.
          if (this.videos.get(id) === entry) this.videos.delete(id)
        })
      })
      .catch((e: Error) => {
        entry.failed = true
        this.problems.set(id, e.name === 'NotReadableError' ? 'In use by another app' : 'Could not open')
      })
  }

  /** Screen or window capture for one source: needs a click (the browser asks what to share). */
  async startDisplay(layerId: string) {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
    const el = document.createElement('video')
    Object.assign(el, { muted: true, playsInline: true, srcObject: stream })
    await el.play().catch(() => {})
    this.displays.set(layerId, el)
    this.waiting.delete(layerId)
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.displays.delete(layerId)
      this.waiting.add(layerId)
    })
  }

  /** Draw one frame of Live (and every other frame, Preview). */
  draw(withPreview: boolean) {
    const s = this.state
    if (!s) return
    const program = s.scenes.find((x) => x.id === s.programSceneId)
    const pctx = this.program.getContext('2d')!
    pctx.globalAlpha = 1
    pctx.fillStyle = '#000'
    pctx.fillRect(0, 0, this.program.width, this.program.height)
    if (this.fadeFrom) {
      const t = (performance.now() - this.fadeFrom.start) / this.fadeFrom.ms
      if (t >= 1) this.fadeFrom = null
      else {
        this.drawWithOverlay(pctx, this.fadeFrom.scene, s, this.program.width, this.program.height)
        pctx.globalAlpha = t
      }
    }
    if (program) this.drawWithOverlay(pctx, program, s, this.program.width, this.program.height)
    pctx.globalAlpha = 1
    if (withPreview) {
      const preview = s.scenes.find((x) => x.id === s.previewSceneId)
      const vctx = this.preview.getContext('2d')!
      vctx.fillStyle = '#000'
      vctx.fillRect(0, 0, this.preview.width, this.preview.height)
      if (preview) this.drawWithOverlay(vctx, preview, s, this.preview.width, this.preview.height)
    }
  }

  /**
   * Draw a small picture of a scene for its scene card. Cheap: a few frames a
   * second at thumbnail size, on the processor's 2D canvas, from the same
   * open cameras and files as Live and Preview.
   */
  drawThumbnail(sceneId: string, canvas: HTMLCanvasElement): boolean {
    const s = this.state
    const scene = s?.scenes.find((x) => x.id === sceneId)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!s || !scene || !ctx) return false
    // Text sizes follow the output picture, so draw at its scale and shrink.
    const w = this.program.width || 1280
    const h = this.program.height || 720
    ctx.save()
    ctx.scale(canvas.width / w, canvas.height / h)
    this.drawScene(ctx, scene, s, w, h)
    ctx.restore()
    return true
  }

  /** A scene, and the Overlay on top of it when it is on and the scene doesn't hide it. */
  /** A small copy of Live, with the Overlay (drawn on the 2D canvas, so it works with either compositor). */
  drawLive(canvas: HTMLCanvasElement): boolean {
    const s = this.state
    const scene = s?.scenes.find((x) => x.id === s.programSceneId)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!s || !scene || !ctx) return false
    const w = this.program.width || 1280
    const h = this.program.height || 720
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(canvas.width / w, canvas.height / h)
    this.drawWithOverlay(ctx, scene, s, w, h)
    ctx.restore()
    return true
  }

  private drawWithOverlay(ctx: CanvasRenderingContext2D, scene: Scene, s: AppState, w: number, h: number) {
    this.drawScene(ctx, scene, s, w, h)
    const overlay = overlayOver(s, scene.id)
    if (overlay) this.drawScene(ctx, overlay, s, w, h, 1)
  }

  private drawScene(ctx: CanvasRenderingContext2D, scene: Scene, s: AppState, w: number, h: number, depth = 0) {
    const alpha = ctx.globalAlpha
    // Fill with black first so a fade reveals the new scene, not the old one through it. (Not for a scene inside a scene.)
    if (depth === 0) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, w, h)
    }
    for (let i = scene.layers.length - 1; i >= 0; i--) {
      const l = scene.layers[i]
      if (!l.visible) continue
      ctx.globalAlpha = alpha
      if (l.kind === 'text') this.drawText(ctx, l, renderTemplate(l.text ?? '', s.data), w, h)
      else if (l.kind === 'countdown') this.drawText(ctx, l, countdownText(l, Date.now(), this.liveAt.get(scene.id)), w, h)
      else if (l.kind === 'color') {
        const b = boxFor(placementOf(l), w, h)
        ctx.fillStyle = l.color ?? '#1e3a8a'
        ctx.fillRect(b.x, b.y, b.w, b.h)
      } else if (l.kind === 'scene') {
        const inner = s.scenes.find((x) => x.id === l.sceneId)
        if (!inner || depth >= 3) continue
        const b = boxFor(placementOf(l), w, h)
        ctx.save()
        ctx.beginPath()
        ctx.rect(b.x, b.y, b.w, b.h)
        ctx.clip()
        ctx.translate(b.x, b.y)
        ctx.scale(b.w / w, b.h / h)
        this.drawScene(ctx, inner, s, w, h, depth + 1)
        ctx.restore()
      } else {
        const src = this.drawableFor(l)
        if (src) this.drawPicture(ctx, src, placementOf(l), w, h)
      }
    }
    ctx.globalAlpha = alpha
  }

  protected drawableFor(l: Layer): Drawable | null {
    if (l.kind === 'video' && l.device) return this.ready(this.videos.get(l.device)?.el)
    if (l.kind === 'media' && l.url) return this.ready(this.videos.get(`media:${l.url}`)?.el)
    if (l.kind === 'image' && l.url) {
      const img = this.images.get(l.url)
      return img?.complete && img.naturalWidth > 0 ? img : null
    }
    if (l.kind === 'screen' || l.kind === 'window') return this.ready(this.displays.get(l.id))
    if (l.kind === 'slideshow' && l.url) {
      const pics = (this.folders.get(l.url) ?? []).filter((img) => img.complete && img.naturalWidth > 0)
      if (!pics.length) return null
      return pics[Math.floor(Date.now() / 1000 / Math.max(1, l.seconds ?? 5)) % pics.length]
    }
    if ((l.kind === 'graphics' || l.kind === 'browser') && this.state) return this.graphics.feedFor(l, this.state)?.canvas ?? null
    return null
  }

  private ready(el: HTMLVideoElement | undefined) {
    return el && el.readyState >= 2 && el.videoWidth > 0 ? el : null
  }

  private drawPicture(ctx: CanvasRenderingContext2D, src: Drawable, place: Placement, w: number, h: number) {
    const sw = src instanceof HTMLVideoElement ? src.videoWidth : src instanceof HTMLCanvasElement ? src.width : src.naturalWidth
    const sh = src instanceof HTMLVideoElement ? src.videoHeight : src instanceof HTMLCanvasElement ? src.height : src.naturalHeight
    const box = boxFor(place, w, h)
    // Fit inside the box, keeping its shape.
    const k = Math.min(box.w / sw, box.h / sh)
    const dw = sw * k
    const dh = sh * k
    const x = box.x + (box.w - dw) / 2
    const y = place === 'full' || place === 'center' ? box.y + (box.h - dh) / 2 : box.y
    if (place !== 'full' && place !== 'center' && src instanceof HTMLVideoElement) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(x - 3, y - 3, dw + 6, dh + 6)
    }
    ctx.drawImage(src, x, y, dw, dh)
  }

  drawText(ctx: CanvasRenderingContext2D, l: Layer, text: string, w: number, h: number) {
    if (!text.trim()) return
    const place = placementOf(l)
    const family = '"Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    if (place === 'lower-third') {
      const size = Math.round(h * 0.045)
      ctx.font = `600 ${size}px ${family}`
      const tw = ctx.measureText(text).width
      const x = w * 0.05
      const y = h * 0.86
      ctx.fillStyle = '#2563d9'
      ctx.fillRect(x, y - size * 0.8, tw + size * 1.4, size * 1.6)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'left'
      ctx.fillText(text, x + size * 0.7, y)
      return
    }
    if (place === 'center' || place === 'full') {
      const size = Math.round(h * 0.08)
      ctx.font = `700 ${size}px ${family}`
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillText(text, w / 2 + 3, h / 2 + 3, w * 0.9)
      ctx.fillStyle = '#fff'
      ctx.fillText(text, w / 2, h / 2, w * 0.9)
      return
    }
    // Top centre and the corners: a dark pill, like a scoreboard.
    const size = Math.round(h * 0.04)
    ctx.font = `700 ${size}px ${family}`
    const tw = Math.min(ctx.measureText(text).width, w * 0.6)
    const pad = size * 0.8
    const bw = tw + pad * 2
    const bh = size * 1.6
    const m = h * 0.04
    const x = place === 'top' ? (w - bw) / 2 : place === 'top-left' ? m : w - bw - m
    const y = place === 'bottom-right' ? h - bh - m : m
    ctx.fillStyle = 'rgba(0,0,0,0.7)'
    ctx.fillRect(x, y, bw, bh)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.fillText(text, x + bw / 2, y + bh / 2, w * 0.6)
  }

  /** A phone connected again or left: open it afresh on the next update. */
  refreshPhones() {
    for (const [id, v] of this.videos) {
      if (!linked(id)) continue
      v.el.srcObject = null
      this.videos.delete(id)
      this.problems.delete(id)
    }
  }

  close() {
    for (const [id, v] of this.videos) stopTracks(id, v.stream)
    for (const v of this.displays.values()) (v.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop())
    this.videos.clear()
    this.displays.clear()
  }
}

/** The box a placement stands for, in a w×h picture. */
export function boxFor(place: Placement, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const m = Math.round(h * 0.03)
  return place === 'full'
    ? { x: 0, y: 0, w, h }
    : place === 'center'
      ? { x: w * 0.25, y: h * 0.25, w: w * 0.5, h: h * 0.5 }
      : place === 'lower-third'
        ? { x: m, y: h * 0.7, w: w * 0.5, h: h * 0.27 }
        : place === 'top'
          ? { x: w * 0.3, y: m, w: w * 0.4, h: h * 0.2 }
          : { x: place === 'top-left' ? m : w * 0.68 - m, y: place === 'bottom-right' ? h * 0.68 - m : m, w: w * 0.32, h: h * 0.32 }
}
