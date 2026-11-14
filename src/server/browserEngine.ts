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
  /** Stream keys, hidden from messages and the log. */
  secrets: string[]
  /** Reconnects in a row that did not stay up. */
  tries: number
  stats?: ReturnType<typeof setInterval>
}

/** How long the studio page has to start sending after Start, before we give up. */
const MEDIA_WAIT_MS = 15_000
/** Close code that tells the page to start sending again after a pause (the reason holds the pause, in ms). */
export const MEDIA_RECONNECT_CODE = 4010
/** A stream that stays up this long counts as back on; the next drop starts counting tries again. */
const STABLE_MS = 30_000
/** Waits before each reconnect. After the last one, the stream ends. */
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000]
/** No video out for this long means the connection is stuck. */
const STALL_MS = 15_000

export class BrowserEngine implements Engine {
  readonly name = 'browser'
  onOutputStopped?: (kind: Kind, reason: string) => void
  /** Messages for the person at the main window (reconnecting, back on). */
  onNotice?: (message: string) => void
  /** Lines for app.log, to find out later why something happened. Never holds a stream key. */
  onLog?: (line: string) => void
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
    const isStream = kind === 'stream'
    const output = new FfmpegOutput(
      this.ffmpeg,
      job.args(codec),
      (error) => {
        if (this.jobs.get(kind) !== job || job.output !== output) return
        job.output = undefined
        clearInterval(job.stats)
        if (!error) {
          this.jobs.delete(kind)
          socket.close()
          return
        }
        this.onLog?.(`${kind} ffmpeg stopped: ${error} | ${output.lastLines.slice(-5).join(' / ')}`)
        const upFor = Date.now() - output.startedAt
        if (upFor > STABLE_MS) job.tries = 0
        const delay = isStream ? RECONNECT_DELAYS_MS[job.tries] : undefined
        if (delay === undefined) {
          this.jobs.delete(kind)
          socket.close()
          const why = isStream && job.tries > 0 ? `The stream ended after ${job.tries} tries to reconnect. ${error}` : error
          this.onLog?.(`${kind} gave up: ${why}`)
          this.onOutputStopped?.(kind, isStream ? `${why} Check the internet connection, or start a new live event on the platform.` : why)
          return
        }
        job.tries++
        this.onLog?.(`stream reconnect ${job.tries}/${RECONNECT_DELAYS_MS.length} in ${delay / 1000}s`)
        this.onNotice?.(`Stream dropped (${error.replace(/\.$/, '')}). Reconnecting in ${delay / 1000} s…`)
        // The page waits, then opens a new connection with a fresh encoder; that starts ffmpeg again.
        socket.close(MEDIA_RECONNECT_CODE, String(delay))
        job.waiting = setTimeout(() => {
          if (this.jobs.get(kind) !== job || job.output) return
          this.jobs.delete(kind)
          this.onOutputStopped?.(kind, 'The main window did not send video again after the stream dropped. Reload it and go live again.')
        }, delay + MEDIA_WAIT_MS)
      },
      { secrets: job.secrets, stallMs: isStream ? STALL_MS : 0, stopOnTargetFailure: isStream }
    )
    job.output = output
    if (isStream && job.tries > 0) {
      const tries = job.tries
      setTimeout(() => {
        if (job.output === output && output.progress.frames > 0) {
          this.onNotice?.('Stream is back on.')
          this.onLog?.(`stream back on after ${tries} tries`)
        }
      }, 8_000)
    }
    // While live, note the numbers every 30 seconds: slow encoding or a slow upload shows up here.
    job.stats = setInterval(() => {
      const p = output.progress
      const backlog = Math.round(output.backlog / 1024)
      this.onLog?.(`${kind} fps=${p.fps} speed=${p.speed} kbps=${p.kbps} dropped=${p.dropped} backlogKB=${backlog}`)
    }, 30_000)
    socket.on('message', (data: Buffer) => output.write(data))
    socket.on('close', () => {
      // The page stopped sending: finish the file or stream cleanly.
      if (this.jobs.get(kind) === job && job.output === output) void output.stop()
    })
  }

  private begin(kind: Kind, args: (codec: string) => string[], file?: string, secrets: string[] = []) {
    if (!this.ffmpeg) {
      throw new CommandError('ffmpeg is missing, so the app cannot stream or record. Run npm install again, or install ffmpeg.')
    }
    if (!this.studio) {
      throw new CommandError('Open the main window on this PC first (http://localhost:7420). It runs the cameras and the sound.')
    }
    if (this.jobs.has(kind)) return
    const job: Job = { args, file, secrets, tries: 0 }
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
    clearInterval(job.stats)
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
    this.onLog?.(`stream to ${targets.map((t) => t.url).join(', ')} with ${this.encoder}, ${preset.width}x${preset.height} ${preset.fps}fps ${preset.videoKbps}kbps`)
    this.begin('stream', () => streamArgs(targets, preset, this.encoder), undefined, targets.map((t) => t.key))
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
