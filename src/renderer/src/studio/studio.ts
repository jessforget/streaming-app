/**
 * The studio: the part of the main window that does the video and sound work
 * on the streaming PC. It follows the app's state (scenes, sources, mixer,
 * stream and record buttons) and:
 *
 * - opens the ATEM Mini, capture cards and audio devices (reported by their real names),
 * - draws Live and Preview,
 * - mixes the sound,
 * - sends the result to the app's server while streaming or recording.
 */
import { QUALITY_PRESETS, cameraRate, presetFor } from '../../../shared/presets'
import type { AppState } from '../../../shared/state'
import type { Bridge } from '../bridge/bridge'
import { Compositor } from './compositor'
import { listDevices, onDeviceChange } from './devices'
import { GpuCompositor } from './gpuCompositor'
import { GpuOutput, gpuEncodeSupported } from './gpuOutput'
import { Mixer } from './mixer'
import { Output } from './output'
import { NetCams } from './netcams'
import { PhoneCams } from './phones'

/**
 * A clock in a worker: it keeps ticking when the window is in the background, unlike animation frames.
 *
 * Only one tick is ever waiting. If drawing a frame takes longer than a frame lasts (a slow PC,
 * many cameras, 60 fps), the late ticks are skipped instead of piling up. Piled-up ticks used to
 * fill the window's queue, so clicks never got a turn and the whole window froze once live.
 */
function workerClock(fps: number, tick: () => void): { setFps(f: number): void; stop(): void } {
  const code = `let ms=33,busy=false,next=0,t=null;
function run(){const now=performance.now();if(!busy){busy=true;postMessage(0)}
next=Math.max(next+ms,now+1);t=setTimeout(run,next-now)}
onmessage=e=>{if(e.data==='done'){busy=false;return}ms=1000/e.data;clearTimeout(t);next=performance.now();run()}`
  const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
  w.onmessage = () => {
    try {
      tick()
    } finally {
      // Straight away, not with a timer: browsers slow timers down to once a second (or once a
      // minute) in a tab that is in the background, which would starve the stream. Clicks still
      // get their turn, because the worker waits for the next frame time before asking again.
      w.postMessage('done')
    }
  }
  w.postMessage(fps)
  return { setFps: (f) => w.postMessage(f), stop: () => w.terminate() }
}

const GPU_FAILED_KEY = 'streaming-app:gpu-failed-early'

export class Studio {
  readonly mixer = new Mixer()
  readonly phones = new PhoneCams()
  /** Network cameras, like a Z CAM E2 on the router. */
  readonly netcams = new NetCams()
  private state: AppState | null = null
  private outputs: Partial<Record<'stream' | 'record', Output | GpuOutput>> = {}
  /** Which qualities the graphics card can encode (checked once at the start). */
  private gpuEncode = new Map<string, boolean>()
  private clock: ReturnType<typeof workerClock> | null = null
  private fps = 30
  private frames = 0
  private measured = 0
  private lastMeasure = performance.now()
  private offDevices: (() => void) | null = null
  private offPhoneOffers: (() => void) | null = null
  private offGraphics: (() => void) | null = null
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<() => void>()
  private media: MediaStream | null = null

  constructor(
    private readonly bridge: Bridge,
    readonly compositor: Compositor = new Compositor()
  ) {}

  /**
   * A studio that draws on the graphics card when it can, else on the 2D canvas as before.
   * Add ?engine=canvas to the address to force the old way (for comparing, or a PC without WebGPU).
   */
  static async create(bridge: Bridge): Promise<Studio> {
    // If the graphics card failed soon after the last start, use the canvas once; the next start tries the card again.
    let failedLastTime = false
    try {
      failedLastTime = localStorage.getItem(GPU_FAILED_KEY) === '1'
      localStorage.removeItem(GPU_FAILED_KEY)
    } catch {
      // storage blocked: just try the card
    }
    const forceCanvas = new URLSearchParams(location.search).get('engine') === 'canvas' || failedLastTime
    const gpu = forceCanvas ? null : await GpuCompositor.create()
    return new Studio(bridge, gpu ?? new Compositor())
  }

  /** How this window makes the video, in words: shown in Settings and written to the log. */
  get engineInfo(): string {
    const c = this.compositor
    if (!(c instanceof GpuCompositor)) return 'Drawing with the processor (2D canvas)'
    const enc = [...this.gpuEncode].filter(([, ok]) => ok).map(([q]) => q)
    return `Drawing on the graphics card (${c.cardName}); encoding on the card for: ${enc.join(', ') || 'none'}`
  }

  async start() {
    // Browsers keep sound off until the person clicks or types on the page once.
    const wake = () => {
      this.mixer.resume()
      if (this.mixer.ctx.state === 'running') {
        window.removeEventListener('pointerdown', wake)
        window.removeEventListener('keydown', wake)
      }
      setTimeout(() => this.changed(), 100)
    }
    window.addEventListener('pointerdown', wake)
    window.addEventListener('keydown', wake)
    this.mixer.ctx.addEventListener('statechange', () => this.changed())
    this.mixer.resume()
    if (this.compositor instanceof GpuCompositor) {
      const started = performance.now()
      this.compositor.onLost = () => {
        if (performance.now() - started < 120_000) {
          try {
            localStorage.setItem(GPU_FAILED_KEY, '1')
          } catch {
            // nothing to remember it in
          }
        }
        this.notice('The graphics card stopped drawing (a driver reset). Reload this window with F5 to get the picture back.')
      }
      for (const [q, preset] of Object.entries(QUALITY_PRESETS)) this.gpuEncode.set(q, await gpuEncodeSupported(preset))
    }
    console.info(`[studio] ${this.engineInfo}`)
    this.clock = workerClock(this.fps, () => this.tick())
    // Phone cameras: answer each phone, and list it with the other devices once its video arrives.
    this.compositor.phoneStream = (id) => this.phones.stream(id) ?? this.netcams.stream(id)
    this.mixer.phoneStream = (id) => this.phones.stream(id)
    this.mixer.mediaElement = (url) => this.compositor.mediaElement(url)
    this.offPhoneOffers = this.bridge.onPhoneOffer?.((offer) => this.phones.answer(offer)) ?? null
    this.phones.subscribe(() => {
      this.compositor.refreshPhones()
      this.mixer.refreshPhones()
      if (this.state) this.update(this.state)
      void this.reportDevices()
    })
    // Network cameras: listed once their picture arrives, like phones.
    let netShown = ''
    this.netcams.subscribe(() => {
      const now = this.netcams.devices().video.map((d) => d.id).join(',')
      if (now === netShown) return
      netShown = now
      this.compositor.refreshPhones()
      if (this.state) this.update(this.state)
      void this.reportDevices()
    })
    void this.netcams.load()
    this.offGraphics = this.watchGraphics()
    await this.reportDevices()
    this.offDevices = onDeviceChange(() => void this.reportDevices())
    this.reportTimer = setInterval(() => {
      void this.bridge.command('studio.report', { fps: this.measured, audioLevels: this.mixer.levels() })
      this.reportCameraRate()
    }, 1000)
  }

  private lastCameraRate = ''

  /**
   * What frame rate the cameras in the scenes send, so the app can stream at the same one
   * (a 25 fps camera in a 30 fps stream shows some pictures twice, which looks like dropped frames).
   * Told to the app only when it changes.
   */
  private reportCameraRate() {
    const st = this.state
    if (!st) return
    const r = cameraRate(st, (id) => this.netcams.fps(id), (id) => this.compositor.deviceRate(id))
    const key = `${r.family}|${r.note}`
    if (key === this.lastCameraRate) return
    this.lastCameraRate = key
    void this.bridge.command('studio.cameraRate', r).catch(() => (this.lastCameraRate = ''))
  }

  /** Called by the screen on every state change. */
  update(state: AppState) {
    this.state = state
    const preset = presetFor(state.stream.quality, state.stream.family)
    if (!state.stream.live && !state.recording.active) this.compositor.setSize(preset.width, preset.height)
    if (preset.fps !== this.fps) {
      this.fps = preset.fps
      this.clock?.setFps(this.fps)
    }
    this.compositor.update(state)
    this.mixer.update(state)
    this.syncOutput('stream', state.stream.live)
    this.syncOutput('record', state.recording.active)
    this.changed()
  }

  private syncOutput(kind: 'stream' | 'record', on: boolean) {
    const running = this.outputs[kind]
    if (on && !running && this.state) {
      this.mixer.resume()
      const quality = this.state.stream.quality
      const preset = presetFor(quality, this.state.stream.family)
      const onProblem = (m: string) => this.notice(m)
      // Encoded once on the graphics card and passed on as is, when it can; otherwise the browser's recorder as before.
      this.outputs[kind] = this.gpuEncode.get(quality)
        ? new GpuOutput(kind, this.compositor.program, this.mixer.output.stream.getAudioTracks()[0], preset, onProblem)
        : new Output(kind, this.programMedia(), preset, onProblem)
    } else if (!on && running) {
      running.stop()
      delete this.outputs[kind]
    }
  }

  /** The Live picture and the program sound, as one stream for the encoder. */
  private programMedia(): MediaStream {
    if (!this.media) {
      // Frames are pushed by our own clock (captureStream(0) + requestFrame), so they keep coming in the background.
      const video = this.compositor.program.captureStream(0).getVideoTracks()[0]
      this.media = new MediaStream([video, ...this.mixer.output.stream.getAudioTracks()])
    }
    return this.media
  }

  private tick() {
    this.frames++
    this.compositor.draw(this.frames % 2 === 0)
    for (const o of Object.values(this.outputs)) if (o instanceof GpuOutput) o.pushFrame()
    const track = this.media?.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined
    track?.requestFrame?.()
    const now = performance.now()
    if (now - this.lastMeasure >= 1000) {
      this.measured = Math.round((this.frames * 1000) / (now - this.lastMeasure))
      this.frames = 0
      this.lastMeasure = now
      this.checkKeepingUp()
    }
  }

  /** Seconds in a row the PC drew too few frames while live, and whether the person was told. */
  private slowFor = 0
  private toldSlow = false
  private skippedBefore = 0

  /** Live, but this PC cannot draw the chosen frame rate: say so once, with what to change. */
  private checkKeepingUp() {
    if (!this.outputs.stream && !this.outputs.record) {
      this.slowFor = 0
      this.toldSlow = false
      this.skippedBefore = 0
      return
    }
    // Frames the graphics card's encoder had no time for, in the last second.
    const skipped = Object.values(this.outputs).reduce((n, o) => n + (o instanceof GpuOutput ? o.skipped : 0), 0)
    const skippedNow = skipped - this.skippedBefore
    this.skippedBefore = skipped
    this.slowFor = this.measured < this.fps * 0.75 || skippedNow > this.fps * 0.25 ? this.slowFor + 1 : 0
    if (this.slowFor >= 5 && !this.toldSlow) {
      this.toldSlow = true
      const intel = this.compositor instanceof GpuCompositor && /intel/i.test(this.compositor.cardName)
      this.notice(
        `This PC is making only ${this.measured} of ${this.fps} frames a second, so the stream may stutter or drop. ` +
          (intel
            ? 'The window is using the built-in Intel graphics, not the NVIDIA card: start the app with "Start Streaming App" (the desktop version), or set Chrome to High performance in Windows Settings > Display > Graphics.'
            : 'Pick a lower quality in Settings (720p, 30 fps is the lightest), close other programs, and keep this window in front.')
      )
    }
  }

  /** Say once when a gfx laptop drops off, and again when its graphics are back. */
  private watchGraphics() {
    const feeds = this.compositor.graphics
    const before = new Map<string, string>()
    return feeds.subscribe(() => {
      const st = this.state
      if (!st) return
      for (const l of st.scenes.flatMap((x) => x.layers)) {
        const status = feeds.statusOf(l, st)
        if (!status || (l.kind !== 'graphics' && l.kind !== 'browser')) continue
        const key = l.url ?? ''
        const was = before.get(key)
        if (was === status) continue
        before.set(key, status)
        const host = (l.url ?? '').replace(/^https?:\/\//i, '').split('/')[0]
        if (status === 'unreachable' && was === 'connected') this.notice(`Lost the graphics from ${host}. The stream keeps going; graphics come back by themselves when the gfx laptop is back.`)
        if (status === 'connected' && was === 'unreachable') this.notice(`Graphics from ${host} are back.`)
      }
    })
  }

  private async reportDevices() {
    try {
      const inputs = await listDevices()
      const phones = this.phones.devices()
      const net = this.netcams.devices()
      await this.bridge.command('inputs.report', {
        video: [...inputs.video, ...phones.video, ...net.video],
        audio: [...inputs.audio, ...phones.audio]
      })
    } catch {
      this.notice('Could not list the cameras and audio devices. Allow camera and microphone access for this page.')
    }
  }

  /** Screen, window or desktop sound: the browser needs a click before it asks what to share. */
  async allowDisplay(layerId: string) {
    await this.compositor.startDisplay(layerId)
    this.changed()
  }

  async allowDesktopSound() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    // We only want the sound; Chrome needs a picture to share sound too.
    stream.getVideoTracks().forEach((t) => (t.enabled = false))
    this.mixer.setDesktop(stream)
    if (this.state) this.mixer.update(this.state)
    this.changed()
  }

  /** Things the person has to click before they work. */
  get waiting(): { id: string; label: string; kind: 'display' | 'desktop' }[] {
    const s = this.state
    if (!s) return []
    const out: { id: string; label: string; kind: 'display' | 'desktop' }[] = []
    for (const id of this.compositor.waiting) {
      const layer = s.scenes.flatMap((x) => x.layers).find((l) => l.id === id)
      if (layer) out.push({ id, label: layer.name, kind: 'display' })
    }
    if (s.audio.some((a) => a.kind === 'desktop') && this.mixer.needsDesktop) out.push({ id: 'desktop', label: 'Desktop sound', kind: 'desktop' })
    return out
  }

  /** False until the browser lets the page play sound (after the first click). */
  get soundOn() {
    return this.mixer.ctx.state === 'running'
  }

  levels() {
    return this.mixer.levels()
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed() {
    this.listeners.forEach((fn) => fn())
  }

  private noticeFn: ((m: string) => void) | null = null
  onNotice(fn: (m: string) => void) {
    this.noticeFn = fn
    return () => {
      if (this.noticeFn === fn) this.noticeFn = null
    }
  }
  private notice(m: string) {
    this.noticeFn?.(m)
  }

  stop() {
    this.clock?.stop()
    this.offDevices?.()
    this.offPhoneOffers?.()
    this.offGraphics?.()
    this.compositor.graphics.close()
    this.phones.close()
    this.netcams.close()
    if (this.reportTimer) clearInterval(this.reportTimer)
    for (const o of Object.values(this.outputs)) o?.stop()
    this.compositor.close()
    this.mixer.close()
  }
}
