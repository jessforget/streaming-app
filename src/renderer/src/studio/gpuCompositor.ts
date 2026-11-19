/**
 * Draws Live and Preview on the graphics card (WebGPU), like OBS does.
 *
 * The scenes, sources and fades work exactly as in the canvas Compositor it
 * extends: only the drawing is different. Camera and video frames go to the
 * graphics card without a copy (importExternalTexture). Pictures are uploaded
 * once. Text, countdowns and graphics are drawn with the 2D canvas once per
 * change (not every frame) and uploaded as a picture.
 */
import { renderTemplate } from '../../../shared/template'
import { countdownText, overlayOver, placementOf, type AppState, type Layer, type Placement, type Scene } from '../../../shared/state'
import { barRects } from '../../../shared/bars'
import { boxFor, Compositor } from './compositor'
import { videoBox, type GraphicsFeed } from './graphics'

type Rect = { x: number; y: number; w: number; h: number }
/** Maps a scene's own w×h picture into the canvas being drawn (for a scene inside a scene). */
type Transform = { ox: number; oy: number; sx: number; sy: number }
type Op =
  | { kind: 'solid'; rect: Rect; clip: Rect | null; alpha: number; color: [number, number, number, number] }
  | { kind: 'tex'; rect: Rect; clip: Rect | null; alpha: number; texture: GPUTexture }
  | { kind: 'ext'; rect: Rect; clip: Rect | null; alpha: number; video: HTMLVideoElement }

const COMMON = /* wgsl */ `
struct U { rect: vec4f, size: vec4f, color: vec4f, misc: vec4f };
@group(0) @binding(0) var<uniform> u: U;
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> O {
  var c = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let q = c[i];
  let px = u.rect.xy + q * u.rect.zw;
  var o: O;
  o.p = vec4f(px.x / u.size.x * 2.0 - 1.0, 1.0 - px.y / u.size.y * 2.0, 0.0, 1.0);
  o.uv = q;
  return o;
}`
const SOLID = `${COMMON}
@fragment fn fs(i: O) -> @location(0) vec4f { return vec4f(u.color.rgb, u.color.a * u.misc.x); }`
const TEX = `${COMMON}
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@fragment fn fs(i: O) -> @location(0) vec4f { let c = textureSample(tex, smp, i.uv); return vec4f(c.rgb, c.a * u.misc.x); }`
const EXT = `${COMMON}
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var ext: texture_external;
@fragment fn fs(i: O) -> @location(0) vec4f { let c = textureSampleBaseClampToEdge(ext, smp, i.uv); return vec4f(c.rgb, u.misc.x); }`

/** CSS colour (as the 2D canvas understands it) → 0..1 RGBA. */
const colorCache = new Map<string, [number, number, number, number]>()
function parseColor(css: string): [number, number, number, number] {
  let c = colorCache.get(css)
  if (c) return c
  const g = document.createElement('canvas').getContext('2d')!
  g.canvas.width = g.canvas.height = 1
  g.fillStyle = css
  g.fillRect(0, 0, 1, 1)
  const d = g.getImageData(0, 0, 1, 1).data
  c = [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255]
  colorCache.set(css, c)
  return c
}

export class GpuCompositor extends Compositor {
  /** The graphics card the browser gave us, for the log and the "which card" notice. */
  readonly cardName: string
  /** Called once if the graphics card stops (driver reset): the page needs a reload. */
  onLost: (why: string) => void = () => {}
  private readonly format: GPUTextureFormat
  private readonly pipes: Record<Op['kind'], GPURenderPipeline>
  private readonly sampler: GPUSampler
  private readonly ctx: { program: GPUCanvasContext; preview: GPUCanvasContext }
  private uniforms: GPUBuffer[] = []
  private used = 0
  private frame = 0
  private gpuImages = new WeakMap<HTMLImageElement, GPUTexture | 'failed'>()
  private texts = new Map<string, { canvas: HTMLCanvasElement; texture: GPUTexture; frame: number }>()

  /** The graphics-card drawer, or null when this browser or PC can't do it (then the canvas one is used). */
  static async create(): Promise<GpuCompositor | null> {
    if (!('gpu' in navigator) || !navigator.gpu) return null
    try {
      // Laptops with two graphics chips: ask for the strong one (the NVIDIA card), not the built-in one.
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) return null
      const device = await adapter.requestDevice()
      const info = adapter.info
      const name = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'graphics card'
      return new GpuCompositor(device, name)
    } catch {
      return null
    }
  }

  private constructor(
    readonly device: GPUDevice,
    cardName: string
  ) {
    super(true)
    this.cardName = cardName
    this.format = navigator.gpu.getPreferredCanvasFormat()
    const configure = (canvas: HTMLCanvasElement) => {
      const c = canvas.getContext('webgpu')
      if (!c) throw new Error('No WebGPU canvas')
      c.configure({ device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      return c
    }
    this.ctx = { program: configure(this.program), preview: configure(this.preview) }
    const blend: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
    }
    const pipe = (code: string) => {
      const module = device.createShaderModule({ code })
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend }] }
      })
    }
    this.pipes = { solid: pipe(SOLID), tex: pipe(TEX), ext: pipe(EXT) }
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    let reported = 0
    device.addEventListener('uncapturederror', (e) => {
      if (reported++ < 5) console.error('[gpu]', (e as GPUUncapturedErrorEvent).error.message)
    })
    const born = performance.now()
    void device.lost.then((l) => {
      console.warn(`[gpu] device lost after ${Math.round(performance.now() - born)} ms: ${l.reason} ${l.message}`)
      if (!this.closing) this.onLost(l.message || 'The graphics card stopped')
    })
  }

  /** Draw one frame of Live (and every other frame, Preview). */
  override draw(withPreview: boolean) {
    const s = this.state
    if (!s) return
    this.frame++
    this.used = 0
    const enc = this.device.createCommandEncoder()
    const w = this.program.width
    const h = this.program.height
    const ops: Op[] = []
    const identity: Transform = { ox: 0, oy: 0, sx: 1, sy: 1 }
    let fadeAlpha = 1
    if (this.fadeFrom) {
      const t = (performance.now() - this.fadeFrom.start) / this.fadeFrom.ms
      if (t >= 1) this.fadeFrom = null
      else {
        this.collect(ops, this.fadeFrom.scene, s, w, h, 0, identity, null, 1)
        this.collectOverlay(ops, this.fadeFrom.scene, s, w, h, 1)
        fadeAlpha = t
      }
    }
    const program = s.scenes.find((x) => x.id === s.programSceneId)
    if (program) {
      this.collect(ops, program, s, w, h, 0, identity, null, fadeAlpha)
      this.collectOverlay(ops, program, s, w, h, fadeAlpha)
    }
    // The manual fader: the Preview scene mixed in on top, as far as the bar is pulled.
    const mixing = this.mixing(s)
    if (mixing) {
      this.collect(ops, mixing.scene, s, w, h, 0, identity, null, mixing.level)
      this.collectOverlay(ops, mixing.scene, s, w, h, mixing.level)
    }
    this.render(enc, this.ctx.program, w, h, ops)
    if (withPreview) {
      const pw = this.preview.width
      const ph = this.preview.height
      const pops: Op[] = []
      const preview = s.scenes.find((x) => x.id === s.previewSceneId)
      if (preview) {
        // Preview shows the scene alone: graphics (the Overlay) are only ever on Live.
        this.collect(pops, preview, s, pw, ph, 0, identity, null, 1)
      }
      this.render(enc, this.ctx.preview, pw, ph, pops)
    }
    this.device.queue.submit([enc.finish()])
    this.dropOldTexts()
  }

  /**
   * The Live picture as RGBA pixels, drawn into a texture of its own (not the window).
   * For checks and tests; costs a copy back from the graphics card, so not for every frame.
   */
  async snapshot(): Promise<ImageData | null> {
    const s = this.state
    const program = s?.scenes.find((x) => x.id === s.programSceneId)
    if (!s || !program) return null
    const w = this.program.width
    const h = this.program.height
    const texture = this.device.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    const ops: Op[] = []
    this.collect(ops, program, s, w, h, 0, { ox: 0, oy: 0, sx: 1, sy: 1 }, null, 1)
    this.collectOverlay(ops, program, s, w, h, 1)
    const mixing = this.mixing(s)
    if (mixing) {
      this.collect(ops, mixing.scene, s, w, h, 0, { ox: 0, oy: 0, sx: 1, sy: 1 }, null, mixing.level)
      this.collectOverlay(ops, mixing.scene, s, w, h, mixing.level)
    }
    const bpr = Math.ceil((w * 4) / 256) * 256
    const buf = this.device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const enc = this.device.createCommandEncoder()
    this.used = 0
    this.render(enc, texture, w, h, ops)
    enc.copyTextureToBuffer({ texture }, { buffer: buf, bytesPerRow: bpr }, [w, h])
    this.device.queue.submit([enc.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const src = new Uint8Array(buf.getMappedRange())
    const out = new ImageData(w, h)
    const bgra = this.format === 'bgra8unorm'
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * bpr + x * 4
        const o = (y * w + x) * 4
        out.data[o] = src[i + (bgra ? 2 : 0)]
        out.data[o + 1] = src[i + 1]
        out.data[o + 2] = src[i + (bgra ? 0 : 2)]
        out.data[o + 3] = 255
      }
    }
    buf.unmap()
    buf.destroy()
    texture.destroy()
    return out
  }

  /** The draws of the Overlay sources that show over this scene in Live, on top of it. */
  private collectOverlay(ops: Op[], scene: Scene, s: AppState, w: number, h: number, alpha: number) {
    const overlay = overlayOver(s, scene.id)
    if (overlay) this.collect(ops, overlay, s, w, h, 1, { ox: 0, oy: 0, sx: 1, sy: 1 }, null, alpha)
  }

  /** The draws for one scene, back to front, in the canvas's pixels. */
  private collect(ops: Op[], scene: Scene, s: AppState, w: number, h: number, depth: number, T: Transform, clip: Rect | null, alpha: number) {
    const map = (r: Rect): Rect => ({ x: T.ox + r.x * T.sx, y: T.oy + r.y * T.sy, w: r.w * T.sx, h: r.h * T.sy })
    // Black first, so a fade shows the new scene and not the old one through it (not for a scene inside a scene).
    if (depth === 0) ops.push({ kind: 'solid', rect: map({ x: 0, y: 0, w, h }), clip, alpha, color: [0, 0, 0, 1] })
    for (let i = scene.layers.length - 1; i >= 0; i--) {
      const l = scene.layers[i]
      if (!l.visible) continue
      if (l.kind === 'text' || l.kind === 'countdown') {
        const text = l.kind === 'text' ? renderTemplate(l.text ?? '', s.data) : countdownText(l, Date.now(), this.liveAt.get(scene.id))
        const texture = this.textTexture(l, text, w, h)
        if (texture) ops.push({ kind: 'tex', rect: map({ x: 0, y: 0, w, h }), clip, alpha, texture })
      } else if (l.kind === 'color') {
        ops.push({ kind: 'solid', rect: map(boxFor(placementOf(l), w, h)), clip, alpha, color: parseColor(l.color ?? '#1e3a8a') })
      } else if (l.kind === 'bars') {
        const b = boxFor(placementOf(l), w, h)
        for (const r of barRects(b.x, b.y, b.w, b.h)) ops.push({ kind: 'solid', rect: map(r), clip, alpha, color: [r.rgb[0] / 255, r.rgb[1] / 255, r.rgb[2] / 255, 1] })
      } else if (l.kind === 'scene') {
        const inner = s.scenes.find((x) => x.id === l.sceneId)
        if (!inner || depth >= 3) continue
        const b = boxFor(placementOf(l), w, h)
        const inT: Transform = { ox: T.ox + b.x * T.sx, oy: T.oy + b.y * T.sy, sx: (T.sx * b.w) / w, sy: (T.sy * b.h) / h }
        this.collect(ops, inner, s, w, h, depth + 1, inT, intersect(clip, map(b)), alpha)
      } else if (l.kind === 'graphics' || l.kind === 'browser') {
        const feed = this.graphics.feedFor(l, s)
        const texture = feed ? this.feedTexture(feed) : null
        if (!feed || !texture) continue
        const page = fitInside(feed.canvas.width, feed.canvas.height, placementOf(l), w, h)
        // A gfx app video handed over to play here: under the page's picture, where the page would show it.
        const v = feed.video
        if (v && this.ready(v.el)) {
          const k = page.w / feed.canvas.width
          const b = videoBox(v, feed.canvas.width, feed.canvas.height)
          const r = { x: page.x + b.x * k, y: page.y + b.y * k, w: b.w * k, h: b.h * k }
          ops.push({ kind: 'solid', rect: map(r), clip, alpha, color: [0, 0, 0, 1] })
          const f = Math.min(r.w / v.el.videoWidth, r.h / v.el.videoHeight)
          const dw = v.el.videoWidth * f
          const dh = v.el.videoHeight * f
          ops.push({ kind: 'ext', rect: map({ x: r.x + (r.w - dw) / 2, y: r.y + (r.h - dh) / 2, w: dw, h: dh }), clip, alpha, video: v.el })
        }
        ops.push({ kind: 'tex', rect: map(page), clip, alpha, texture })
      } else {
        const src = this.drawableFor(l)
        if (!src || src instanceof HTMLCanvasElement) continue
        const isVideo = src instanceof HTMLVideoElement
        const sw = isVideo ? src.videoWidth : src.naturalWidth
        const sh = isVideo ? src.videoHeight : src.naturalHeight
        const place = placementOf(l)
        const r = fitInside(sw, sh, place, w, h)
        if (place !== 'full' && place !== 'center' && isVideo) {
          ops.push({ kind: 'solid', rect: map({ x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 }), clip, alpha, color: [0, 0, 0, 0.5] })
        }
        if (isVideo) ops.push({ kind: 'ext', rect: map(r), clip, alpha, video: src })
        else {
          const texture = this.imageTexture(src)
          if (texture) ops.push({ kind: 'tex', rect: map(r), clip, alpha, texture })
        }
      }
    }
  }

  private render(enc: GPUCommandEncoder, target: GPUCanvasContext | GPUTexture, w: number, h: number, ops: Op[]) {
    const texture = 'getCurrentTexture' in target ? target.getCurrentTexture() : target
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }]
    })
    for (const op of ops) {
      const clip = op.clip ? intersect(op.clip, { x: 0, y: 0, w, h }) : { x: 0, y: 0, w, h }
      const sx = Math.max(0, Math.floor(clip.x))
      const sy = Math.max(0, Math.floor(clip.y))
      const sw = Math.min(w, Math.ceil(clip.x + clip.w)) - sx
      const sh = Math.min(h, Math.ceil(clip.y + clip.h)) - sy
      if (sw <= 0 || sh <= 0 || op.alpha <= 0) continue
      let resource: GPUBindGroupEntry | null = null
      let kind = op.kind
      if (op.kind === 'ext') {
        if (!this.copyVideos) {
          try {
            resource = { binding: 2, resource: this.device.importExternalTexture({ source: op.video }) }
          } catch {
            // Some drivers can't share video frames with WebGPU: copy them instead (still on the graphics card).
            this.copyVideos = true
            console.warn('[gpu] video frames are copied (importExternalTexture failed)')
          }
        }
        if (this.copyVideos) {
          const texture = this.videoTexture(op.video)
          if (!texture) continue
          resource = { binding: 2, resource: texture.createView() }
          kind = 'tex'
        }
      } else if (op.kind === 'tex') resource = { binding: 2, resource: op.texture.createView() }
      const buf = this.uniform([op.rect.x, op.rect.y, op.rect.w, op.rect.h, w, h, 0, 0, ...(op.kind === 'solid' ? op.color : [1, 1, 1, 1]), op.alpha, 0, 0, 0])
      const pipe = this.pipes[kind]
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: buf } }]
      if (resource) entries.push({ binding: 1, resource: this.sampler }, resource)
      pass.setPipeline(pipe)
      pass.setBindGroup(0, this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries }))
      pass.setScissorRect(sx, sy, sw, sh)
      pass.draw(6)
    }
    pass.end()
  }

  /** A small buffer for one draw's numbers; buffers are reused every frame. */
  private uniform(values: number[]): GPUBuffer {
    let buf = this.uniforms[this.used]
    if (!buf) {
      buf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      this.uniforms.push(buf)
    }
    this.used++
    this.device.queue.writeBuffer(buf, 0, new Float32Array(values))
    return buf
  }

  /** When true, video frames are copied into textures each frame instead of shared. */
  private copyVideos = false
  private videoTextures = new WeakMap<HTMLVideoElement, { texture: GPUTexture; frame: number }>()

  /** This frame of a video, copied into a texture (once per drawn frame, however many times it is shown). */
  private videoTexture(video: HTMLVideoElement): GPUTexture | null {
    const w = video.videoWidth
    const h = video.videoHeight
    let v = this.videoTextures.get(video)
    if (!v || v.texture.width !== w || v.texture.height !== h) {
      v?.texture.destroy()
      const texture = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      })
      v = { texture, frame: -1 }
      this.videoTextures.set(video, v)
    }
    if (v.frame !== this.frame) {
      try {
        this.device.queue.copyExternalImageToTexture({ source: video }, { texture: v.texture }, [w, h])
      } catch {
        // Last resort, through the processor (slow, but the picture keeps going).
        this.upload(video, v.texture, w, h)
      }
      v.frame = this.frame
    }
    return v.texture
  }

  /** A picture file, uploaded to the graphics card once. */
  private imageTexture(img: HTMLImageElement): GPUTexture | null {
    const have = this.gpuImages.get(img)
    if (have === 'failed') return null
    if (have) return have
    try {
      const texture = this.device.createTexture({
        size: [img.naturalWidth, img.naturalHeight],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      })
      this.upload(img, texture, img.naturalWidth, img.naturalHeight)
      this.gpuImages.set(img, texture)
      return texture
    } catch {
      this.gpuImages.set(img, 'failed')
      return null
    }
  }

  private feedTextures = new WeakMap<GraphicsFeed, { texture: GPUTexture; version: number }>()

  /**
   * A graphics page's picture on the graphics card. Only the part that changed
   * since the last frame is copied, so a still lower third costs nothing.
   */
  private feedTexture(feed: GraphicsFeed): GPUTexture | null {
    const { width: w, height: h } = feed.canvas
    if (!w || !h) return null
    let t = this.feedTextures.get(feed)
    if (!t || t.texture.width !== w || t.texture.height !== h) {
      t?.texture.destroy()
      const texture = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      })
      t = { texture, version: -1 }
      this.feedTextures.set(feed, t)
      feed.dirty = { x: 0, y: 0, w, h }
    }
    if (t.version !== feed.version && feed.dirty) {
      const d = feed.dirty
      const x = Math.max(0, Math.floor(d.x))
      const y = Math.max(0, Math.floor(d.y))
      const dw = Math.min(w - x, Math.ceil(d.w))
      const dh = Math.min(h - y, Math.ceil(d.h))
      if (dw > 0 && dh > 0) {
        const data = feed.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, dw, dh).data
        this.device.queue.writeTexture({ texture: t.texture, origin: [x, y] }, data, { bytesPerRow: dw * 4 }, [dw, dh])
      }
      feed.dirty = null
      t.version = feed.version
    }
    return t.texture
  }

  /** Text, drawn with the same look as the canvas version, redrawn only when the words change. */
  private textTexture(l: Layer, text: string, w: number, h: number): GPUTexture | null {
    if (!text.trim()) return null
    const key = `${placementOf(l)}|${w}x${h}|${text}`
    const have = this.texts.get(key)
    if (have) {
      have.frame = this.frame
      return have.texture
    }
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    this.drawText(canvas.getContext('2d')!, l, text, w, h)
    const texture = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    })
    this.upload(canvas, texture, w, h)
    this.texts.set(key, { canvas, texture, frame: this.frame })
    return texture
  }

  /**
   * Hand a picture to the graphics card through the processor. (The direct copy,
   * copyExternalImageToTexture, crashed the graphics device in testing, and this
   * only runs when a picture loads or words change, not every frame.)
   */
  private upload(source: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement, texture: GPUTexture, w: number, h: number) {
    let canvas = source instanceof HTMLCanvasElement ? source : null
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d')!.drawImage(source, 0, 0)
    }
    const data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data
    this.device.queue.writeTexture({ texture }, data, { bytesPerRow: w * 4 }, [w, h])
  }

  /** Text no longer on screen (a countdown's last second, edited words): free its picture. */
  private dropOldTexts() {
    if (this.frame % 30 !== 0) return
    for (const [key, t] of this.texts) {
      if (this.frame - t.frame > 30) {
        t.texture.destroy()
        this.texts.delete(key)
      }
    }
  }

  private closing = false
  override close() {
    this.closing = true
    super.close()
    for (const t of this.texts.values()) t.texture.destroy()
    this.texts.clear()
    this.device.destroy()
  }
}

/** Where a w×h picture lands in a placement's box, keeping its shape (same as the canvas version). */
export function fitInside(sw: number, sh: number, place: Placement, w: number, h: number): Rect {
  const box = boxFor(place, w, h)
  const k = Math.min(box.w / sw, box.h / sh)
  const dw = sw * k
  const dh = sh * k
  const x = box.x + (box.w - dw) / 2
  const y = place === 'full' || place === 'center' ? box.y + (box.h - dh) / 2 : box.y
  return { x, y, w: dw, h: dh }
}

function intersect(a: Rect | null, b: Rect): Rect {
  if (!a) return b
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) }
}
