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
import { QUALITY_PRESETS } from '../../../shared/presets'
import type { AppState } from '../../../shared/state'
import type { Bridge } from '../bridge/bridge'
import { Compositor } from './compositor'
import { listDevices, onDeviceChange } from './devices'
import { Mixer } from './mixer'
import { Output } from './output'

/** A clock in a worker: it keeps ticking when the window is in the background, unlike animation frames. */
function workerClock(fps: number, tick: () => void): { setFps(f: number): void; stop(): void } {
  const code = `let t=null;onmessage=e=>{clearInterval(t);t=setInterval(()=>postMessage(0),1000/e.data)}`
  const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
  w.onmessage = tick
  w.postMessage(fps)
  return { setFps: (f) => w.postMessage(f), stop: () => w.terminate() }
}

export class Studio {
  readonly compositor = new Compositor()
  readonly mixer = new Mixer()
  private state: AppState | null = null
  private outputs: Partial<Record<'stream' | 'record', Output>> = {}
  private clock: ReturnType<typeof workerClock> | null = null
  private fps = 30
  private frames = 0
  private measured = 0
  private lastMeasure = performance.now()
  private offDevices: (() => void) | null = null
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<() => void>()
  private media: MediaStream | null = null

  constructor(private readonly bridge: Bridge) {}

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
    this.clock = workerClock(this.fps, () => this.tick())
    await this.reportDevices()
    this.offDevices = onDeviceChange(() => void this.reportDevices())
    this.reportTimer = setInterval(() => {
      void this.bridge.command('studio.report', { fps: this.measured, audioLevels: this.mixer.levels() })
    }, 1000)
  }

  /** Called by the screen on every state change. */
  update(state: AppState) {
    this.state = state
    const preset = QUALITY_PRESETS[state.stream.quality]
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
      this.outputs[kind] = new Output(kind, this.programMedia(), QUALITY_PRESETS[this.state.stream.quality], (m) => this.notice(m))
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
    const track = this.media?.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined
    track?.requestFrame?.()
    const now = performance.now()
    if (now - this.lastMeasure >= 1000) {
      this.measured = Math.round((this.frames * 1000) / (now - this.lastMeasure))
      this.frames = 0
      this.lastMeasure = now
    }
  }

  private async reportDevices() {
    try {
      const inputs = await listDevices()
      await this.bridge.command('inputs.report', inputs)
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
    if (this.reportTimer) clearInterval(this.reportTimer)
    for (const o of Object.values(this.outputs)) o?.stop()
    this.compositor.close()
    this.mixer.close()
  }
}
