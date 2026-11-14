/**
 * Draws the scenes, live, on canvases: the Live picture (what goes out) at
 * full quality, and the Preview picture smaller. Sources are drawn back to
 * front: the bottom of the source list first, the top last (in front).
 */
import { renderTemplate } from '../../../shared/template'
import { placementOf, type AppState, type Layer, type Placement, type Scene } from '../../../shared/state'

type Drawable = HTMLVideoElement | HTMLImageElement

/** The address the browser loads a picture or video file from: through the app, for files on this PC. */
export function fileUrl(path: string): string {
  return /^https?:\/\//i.test(path) ? path : `/files?path=${encodeURIComponent(path)}`
}

export class Compositor {
  readonly program = document.createElement('canvas')
  readonly preview = document.createElement('canvas')
  private state: AppState | null = null
  private videos = new Map<string, { el: HTMLVideoElement; stream?: MediaStream; failed?: boolean }>()
  private images = new Map<string, HTMLImageElement>()
  /** Screen and window sources, once the person picked what to share. */
  private displays = new Map<string, HTMLVideoElement>()
  private shownProgram = ''
  private fadeFrom: { scene: Scene; start: number; ms: number } | null = null
  /** Sources that need a click to start (screen and window capture). */
  readonly waiting = new Set<string>()
  /** Video devices that could not be opened, with the reason. */
  readonly problems = new Map<string, string>()

  constructor() {
    this.setSize(1920, 1080)
  }

  setSize(w: number, h: number) {
    if (this.program.width !== w || this.program.height !== h) {
      this.program.width = w
      this.program.height = h
    }
    this.preview.width = 640
    this.preview.height = Math.round((640 * h) / w)
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
  }

  /** Open every capture device used in any scene; close the rest. */
  private syncSources(state: AppState) {
    const devices = new Set<string>()
    const files = new Set<string>()
    this.waiting.clear()
    for (const scene of state.scenes) {
      for (const l of scene.layers) {
        if (l.kind === 'video' && l.device) devices.add(l.device)
        if ((l.kind === 'image' || l.kind === 'media') && l.url) files.add(`${l.kind}:${l.url}`)
        if ((l.kind === 'screen' || l.kind === 'window') && !this.displays.has(l.id)) this.waiting.add(l.id)
      }
    }
    for (const id of devices) if (!this.videos.has(id)) this.openDevice(id, state)
    for (const [id, v] of this.videos) {
      if (!id.startsWith('media:') && !devices.has(id)) {
        v.stream?.getTracks().forEach((t) => t.stop())
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
        Object.assign(el, { src: fileUrl(url), loop: true, muted: true, playsInline: true })
        void el.play().catch(() => {})
        this.videos.set(`media:${url}`, { el })
      }
    }
  }

  private openDevice(id: string, state: AppState) {
    const el = document.createElement('video')
    Object.assign(el, { muted: true, playsInline: true, autoplay: true })
    const entry: { el: HTMLVideoElement; stream?: MediaStream; failed?: boolean } = { el }
    this.videos.set(id, entry)
    const fps = state.stream.quality === 'high' ? 60 : 30
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
        this.drawScene(pctx, this.fadeFrom.scene, s, this.program.width, this.program.height)
        pctx.globalAlpha = t
      }
    }
    if (program) this.drawScene(pctx, program, s, this.program.width, this.program.height)
    pctx.globalAlpha = 1
    if (withPreview) {
      const preview = s.scenes.find((x) => x.id === s.previewSceneId)
      const vctx = this.preview.getContext('2d')!
      vctx.fillStyle = '#000'
      vctx.fillRect(0, 0, this.preview.width, this.preview.height)
      if (preview) this.drawScene(vctx, preview, s, this.preview.width, this.preview.height)
    }
  }

  private drawScene(ctx: CanvasRenderingContext2D, scene: Scene, s: AppState, w: number, h: number) {
    const alpha = ctx.globalAlpha
    // Fill with black first so a fade reveals the new scene, not the old one through it.
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    for (let i = scene.layers.length - 1; i >= 0; i--) {
      const l = scene.layers[i]
      if (!l.visible) continue
      ctx.globalAlpha = alpha
      if (l.kind === 'text') this.drawText(ctx, l, renderTemplate(l.text ?? '', s.data), w, h)
      else {
        const src = this.drawableFor(l)
        if (src) this.drawPicture(ctx, src, placementOf(l), w, h)
      }
    }
    ctx.globalAlpha = alpha
  }

  private drawableFor(l: Layer): Drawable | null {
    if (l.kind === 'video' && l.device) return this.ready(this.videos.get(l.device)?.el)
    if (l.kind === 'media' && l.url) return this.ready(this.videos.get(`media:${l.url}`)?.el)
    if (l.kind === 'image' && l.url) {
      const img = this.images.get(l.url)
      return img?.complete && img.naturalWidth > 0 ? img : null
    }
    if (l.kind === 'screen' || l.kind === 'window') return this.ready(this.displays.get(l.id))
    return null // browser sources need the desktop version
  }

  private ready(el: HTMLVideoElement | undefined) {
    return el && el.readyState >= 2 && el.videoWidth > 0 ? el : null
  }

  private drawPicture(ctx: CanvasRenderingContext2D, src: Drawable, place: Placement, w: number, h: number) {
    const sw = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth
    const sh = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight
    const m = Math.round(h * 0.03)
    const box =
      place === 'full'
        ? { x: 0, y: 0, w, h }
        : place === 'center'
          ? { x: w * 0.25, y: h * 0.25, w: w * 0.5, h: h * 0.5 }
          : place === 'lower-third'
            ? { x: m, y: h * 0.7, w: w * 0.5, h: h * 0.27 }
            : place === 'top'
              ? { x: w * 0.3, y: m, w: w * 0.4, h: h * 0.2 }
              : { x: place === 'top-left' ? m : w * 0.68 - m, y: place === 'bottom-right' ? h * 0.68 - m : m, w: w * 0.32, h: h * 0.32 }
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

  private drawText(ctx: CanvasRenderingContext2D, l: Layer, text: string, w: number, h: number) {
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

  close() {
    for (const v of this.videos.values()) v.stream?.getTracks().forEach((t) => t.stop())
    for (const v of this.displays.values()) (v.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop())
    this.videos.clear()
    this.displays.clear()
  }
}
