/**
 * The engine of the web version. The main window on the streaming PC (the
 * "studio" page) opens the cameras and audio devices, draws the scenes and
 * mixes the sound, all in the browser. It sends the finished picture and sound
 * here, and ffmpeg turns them into the stream and the recording.
 *
 * So most engine calls are nothing to do here: the studio page follows the
 * app's state and redraws by itself.
 */
import { mkdirSync } from 'node:fs'
import { cpus, homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { WebSocket } from 'ws'
import { CommandError } from '../shared/protocol'
import type { QualityPreset } from '../shared/presets'
import type { AppState, InputDevice } from '../shared/state'
import type { Engine, EngineStats, StreamTarget } from '../core/ports'
import { FfmpegOutput, recordArgs, streamArgs } from './ffmpeg'

type Kind = 'stream' | 'record'

interface Job {
  args: (codec: string) => string[]
  output?: FfmpegOutput
  waiting?: ReturnType<typeof setTimeout>
  file?: string
}

/** How long the studio page has to start sending after Start, before we give up. */
const MEDIA_WAIT_MS = 15_000

export class BrowserEngine implements Engine {
  readonly name = 'browser'
  onOutputStopped?: (kind: Kind, reason: string) => void
  private inputs: { video: InputDevice[]; audio: InputDevice[] } = { video: [], audio: [] }
  private studio = false
  private jobs = new Map<Kind, Job>()
  private page = { fps: 0, audioLevels: {} as Record<string, number> }
  private cpuBefore = cpuTimes()
  private cpu = 0

  constructor(
    private readonly ffmpeg: string | null,
    private readonly encoder: string
  ) {}

  /** The studio page came or went. */
  setStudio(present: boolean) {
    this.studio = present
    if (present) return
    this.page = { fps: 0, audioLevels: {} }
    for (const kind of [...this.jobs.keys()]) {
      void this.finish(kind)
      this.onOutputStopped?.(kind, `The ${kind === 'stream' ? 'stream' : 'recording'} stopped because the main window was closed.`)
    }
  }

  get hasStudio() {
    return this.studio
  }

  /** The studio page connected to send video for a stream or a recording. */
  handleMedia(socket: WebSocket, kind: Kind, codec: string) {
    const job = this.jobs.get(kind)
    if (!job || job.output || !this.ffmpeg) return socket.close(1008, 'Not expecting video now')
    clearTimeout(job.waiting)
    job.output = new FfmpegOutput(this.ffmpeg, job.args(codec), (error) => {
      if (this.jobs.get(kind) !== job) return
      this.jobs.delete(kind)
      socket.close()
      if (error) this.onOutputStopped?.(kind, error)
    })
    socket.on('message', (data: Buffer) => job.output?.write(data))
    socket.on('close', () => {
      // The page stopped sending: finish the file or stream cleanly.
      if (this.jobs.get(kind) === job) void job.output?.stop()
    })
  }

  private begin(kind: Kind, args: (codec: string) => string[], file?: string) {
    if (!this.ffmpeg) {
      throw new CommandError('ffmpeg is missing, so the app cannot stream or record. Run npm install again, or install ffmpeg.')
    }
    if (!this.studio) {
      throw new CommandError('Open the main window on this PC first (http://localhost:7420). It runs the cameras and the sound.')
    }
    if (this.jobs.has(kind)) return
    const job: Job = { args, file }
    job.waiting = setTimeout(() => {
      if (this.jobs.get(kind) !== job || job.output) return
      this.jobs.delete(kind)
      this.onOutputStopped?.(kind, 'The main window did not send any video. Reload it and try again.')
    }, MEDIA_WAIT_MS)
    this.jobs.set(kind, job)
  }

  private async finish(kind: Kind) {
    const job = this.jobs.get(kind)
    if (!job) return
    this.jobs.delete(kind)
    clearTimeout(job.waiting)
    await job.output?.stop()
  }

  // ---------- Engine ----------

  /** Until the main window reports, the devices seen last time stand in (so a renamed id can be followed). */
  async init(s: AppState) {
    this.inputs = s.inputs
  }
  async listDevices() {
    return this.inputs
  }
  /** The studio page reports the devices its browser can open. */
  setInputs(inputs: AppState['inputs']) {
    this.inputs = inputs
  }
  async setScene() {}
  async removeScene() {}
  async setAudioSources() {}
  async setPreviewScene() {}
  async setProgramScene() {}
  async setLayerVisible() {}
  async setLayerText() {}
  async setVolume() {}
  async setMuted() {}

  async startStream(targets: StreamTarget[], preset: QualityPreset) {
    this.begin('stream', () => streamArgs(targets, preset, this.encoder))
  }
  async stopStream() {
    await this.finish('stream')
  }

  async startRecording(folder: string, format: 'mp4' | 'mkv', preset: QualityPreset) {
    const dir = isAbsolute(folder) ? folder : join(homedir(), folder)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      throw new CommandError(`Couldn't make the recordings folder ${dir}. Pick another one in Settings.`)
    }
    const file = join(dir, `Recording ${stamp(new Date())}.${format}`)
    this.begin('record', (codec) => recordArgs(file, format, codec, preset, this.encoder), file)
  }
  async stopRecording() {
    await this.finish('record')
  }

  report(r: { fps: number; audioLevels: Record<string, number> }) {
    this.page = r
  }

  readStats(): EngineStats {
    const now = cpuTimes()
    const busy = now.busy - this.cpuBefore.busy
    const total = now.total - this.cpuBefore.total
    if (total > 0) this.cpu = Math.round((busy / total) * 100)
    this.cpuBefore = now
    const stream = this.jobs.get('stream')?.output?.progress
    const record = this.jobs.get('record')?.output?.progress
    const p = stream ?? record
    return {
      fps: p?.fps || this.page.fps,
      cpu: this.cpu,
      droppedFrames: p?.dropped ?? 0,
      totalFrames: p?.frames ?? 0,
      audioLevels: this.page.audioLevels
    }
  }

  async shutdown() {
    await Promise.all([...this.jobs.keys()].map((k) => this.finish(k)))
  }
}

function cpuTimes() {
  let busy = 0
  let total = 0
  for (const c of cpus()) {
    const t = c.times
    busy += t.user + t.nice + t.sys + t.irq
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { busy, total }
}

const pad = (n: number) => String(n).padStart(2, '0')
function stamp(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}
