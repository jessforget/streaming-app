/**
 * Turning the studio page's video into a stream or a recording, with ffmpeg.
 *
 * The page sends its picture and sound as WebM (from the browser's
 * MediaRecorder) over a local WebSocket. For a stream, ffmpeg re-encodes to
 * H.264 + AAC with a keyframe every 2 seconds (what YouTube, Facebook and
 * Instagram ask for) and sends one copy per platform over RTMP(S). For a
 * recording it keeps the picture as it is and saves an MKV or MP4 file.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { QualityPreset } from '../shared/presets'
import type { StreamTarget } from '../core/ports'

export function findFfmpeg(): string | null {
  const candidates: string[] = []
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundled = require('ffmpeg-static') as string | null
    if (bundled) candidates.push(bundled)
  } catch {
    // not installed: fall back to ffmpeg on the PATH
  }
  candidates.push('ffmpeg')
  for (const c of candidates) {
    const r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 10_000 })
    if (r.status === 0) return c
  }
  return null
}

/**
 * The best H.264 encoder that actually works on this PC: NVIDIA, then Intel,
 * then AMD, then x264 on the processor. Each is tried with one tiny frame,
 * because an encoder can be built in without the graphics card to run it.
 */
export function pickEncoder(ffmpeg: string): string {
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    const r = spawnSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30', '-frames:v', '1', '-c:v', enc, '-f', 'null', '-'],
      { timeout: 15_000 }
    )
    if (r.status === 0) return enc
  }
  return 'libx264'
}

function encoderArgs(encoder: string, preset: QualityPreset): string[] {
  const k = preset.videoKbps
  const rate = ['-b:v', `${k}k`, '-maxrate', `${k}k`, '-bufsize', `${k * 2}k`]
  const gop = ['-g', String(preset.fps * 2), '-keyint_min', String(preset.fps * 2)]
  switch (encoder) {
    case 'h264_nvenc':
      // No extra keyframes on scene changes: YouTube wants one exactly every 2 seconds.
      return ['-c:v', encoder, '-preset', 'p5', '-tune', 'll', '-rc', 'cbr', '-no-scenecut', '1', '-forced-idr', '1', '-profile:v', 'high', ...rate, ...gop]
    case 'h264_qsv':
      return ['-c:v', encoder, '-preset', 'veryfast', ...rate, ...gop]
    case 'h264_amf':
      return ['-c:v', encoder, '-usage', 'lowlatency', '-rc', 'cbr', ...rate, ...gop]
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-sc_threshold', '0', ...rate, ...gop]
  }
}

/** rtmp(s)://server/app + key → the address ffmpeg sends to. */
export function ingestAddress(t: StreamTarget): string {
  return `${t.url.replace(/\/+$/, '')}/${t.key}`
}

/** Characters that mean something to ffmpeg's tee output must be escaped in each address. */
const teeEscape = (s: string) => s.replace(/[\\|[\]]/g, (c) => `\\${c}`)

const INPUT = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-thread_queue_size', '1024', '-i', 'pipe:0']
const PROGRESS = ['-progress', 'pipe:1', '-stats_period', '1', '-nostats']

/**
 * One encode per picture shape, sent to every platform at once (ffmpeg's tee
 * output). Instagram gets a vertical 720×1280 picture cut from the middle of
 * the Live picture; the others get the Live picture as it is.
 */
export function streamArgs(targets: StreamTarget[], preset: QualityPreset, encoder: string): string[] {
  const fit = `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease,pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2,fps=${preset.fps},format=yuv420p`
  const vertical = targets.some((t) => t.vertical)
  const wide = targets.some((t) => !t.vertical)
  const slave = (t: StreamTarget) => {
    const select = vertical && wide ? `:select=\\'v:${t.vertical ? 1 : 0},a\\'` : ''
    return `[f=flv${select}:flvflags=no_duration_filesize:onfail=ignore]${teeEscape(ingestAddress(t))}`
  }
  const tall = 'crop=trunc(ih*9/16/2)*2:ih,scale=720:1280,setsar=1,format=yuv420p'
  const video =
    vertical && wide
      ? ['-filter_complex', `[0:v]${fit},split=2[wide][v2];[v2]${tall}[tall]`, '-map', '[wide]', '-map', '[tall]']
      : ['-map', '0:v:0', '-vf', vertical ? `${fit},${tall}` : fit]
  return [
    ...INPUT,
    ...PROGRESS,
    ...video,
    '-map', '0:a:0',
    ...encoderArgs(encoder, preset),
    '-c:a', 'aac', '-b:a', `${preset.audioKbps}k`, '-ar', '48000', '-ac', '2',
    '-flags', '+global_header',
    '-f', 'tee', targets.map(slave).join('|')
  ]
}

export function recordArgs(file: string, format: 'mp4' | 'mkv', codec: string, preset: QualityPreset, encoder: string): string[] {
  // MKV keeps whatever the browser made. MP4 needs H.264; other codecs are re-encoded.
  const video = format === 'mkv' || codec === 'h264' ? ['-c:v', 'copy'] : encoderArgs(encoder, preset)
  const audio = format === 'mkv' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', `${preset.audioKbps}k`]
  // Fragmented MP4 stays playable if the PC crashes mid-recording.
  const container = format === 'mp4' ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'] : []
  return [...INPUT, ...PROGRESS, '-map', '0:v:0', '-map', '0:a:0?', ...video, ...audio, ...container, '-y', file]
}

const MAX_BACKLOG_BYTES = 48 * 1024 * 1024

export interface OutputProgress {
  frames: number
  dropped: number
  fps: number
  speed: number
  /** Kbit/s that ffmpeg is sending, as it reports it. */
  kbps: number
}

/** Stream keys must never reach the screen or the log: ffmpeg prints the full address on errors. */
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const k of secrets) if (k) out = out.split(k).join('****')
  return out
}

export interface OutputOptions {
  /** Texts to hide in error messages and the log (stream keys). */
  secrets?: string[]
  /** Stop ffmpeg when no frame has gone out for this long (a stuck connection). 0 = off. */
  stallMs?: number
  /** For a stream with several platforms: stop as soon as one platform is lost, so it can reconnect. */
  stopOnTargetFailure?: boolean
}

/** One running ffmpeg, fed by the studio page. */
export class FfmpegOutput {
  readonly progress: OutputProgress = { frames: 0, dropped: 0, fps: 0, speed: 0, kbps: 0 }
  readonly startedAt = Date.now()
  private proc: ChildProcess
  private stopping = false
  private failure: string | null = null
  private errors: string[] = []
  private ended: Promise<void>
  private watchdog?: ReturnType<typeof setInterval>
  private secrets: string[]

  constructor(ffmpeg: string, args: string[], onExit: (error: string | null) => void, opts: OutputOptions = {}) {
    this.secrets = opts.secrets ?? []
    this.proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    if (opts.stallMs) {
      let lastFrames = -1
      let lastMove = Date.now()
      this.watchdog = setInterval(() => {
        if (this.progress.frames !== lastFrames) {
          lastFrames = this.progress.frames
          lastMove = Date.now()
        } else if (Date.now() - lastMove > opts.stallMs!) {
          this.fail('The stream stopped moving: no video went out for a while.')
        }
      }, 1000)
    }
    let buf = ''
    this.proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const [k, v] = line.trim().split('=')
        if (k === 'frame') this.progress.frames = Number(v) || 0
        else if (k === 'drop_frames') this.progress.dropped = Number(v) || 0
        else if (k === 'fps') this.progress.fps = Number(v) || 0
        else if (k === 'speed') this.progress.speed = parseFloat(v) || 0
        else if (k === 'bitrate') this.progress.kbps = parseFloat(v) || 0
      }
    })
    this.proc.stderr!.on('data', (d: Buffer) => {
      for (const raw of d.toString().split('\n')) {
        const line = redact(raw.trim(), this.secrets)
        if (!line) continue
        this.errors.push(line)
        // The tee output keeps going when one platform drops; we would rather reconnect it.
        if (opts.stopOnTargetFailure && /Slave muxer #\d+ failed|All tee outputs failed/i.test(line)) {
          this.fail(plainError(this.errors))
        }
      }
      this.errors = this.errors.slice(-20)
    })
    this.proc.stdin!.on('error', () => {
      // ffmpeg exited; the exit handler reports why
    })
    this.ended = new Promise((resolve) => {
      this.proc.on('exit', (code) => {
        clearInterval(this.watchdog)
        resolve()
        if (this.failure) onExit(this.failure)
        else onExit(this.stopping || code === 0 ? null : plainError(this.errors))
      })
      this.proc.on('error', (e) => {
        clearInterval(this.watchdog)
        resolve()
        onExit(`Could not start ffmpeg: ${e.message}`)
      })
    })
  }

  /** ffmpeg's last lines, keys hidden. */
  get lastLines(): string[] {
    return [...this.errors]
  }

  /** Bytes from the page waiting for ffmpeg: grows when the encoder can't keep up. */
  get backlog(): number {
    return this.proc.stdin?.writableLength ?? 0
  }

  write(chunk: Buffer) {
    if (this.stopping || !this.proc.stdin?.writable) return
    // Over ~20 seconds of video waiting means the encoder fell behind for good: start over rather than pile up memory.
    if (this.proc.stdin.writableLength > MAX_BACKLOG_BYTES) {
      this.fail('The video encoder fell behind (the PC or graphics card is too busy).')
      return
    }
    this.proc.stdin.write(chunk)
  }

  /** Give up on this run with a reason (the exit handler reports it). */
  private fail(reason: string) {
    if (this.stopping || this.failure) return
    this.failure = reason
    clearInterval(this.watchdog)
    this.proc.kill('SIGKILL')
  }

  /** Finish cleanly: close the input so ffmpeg writes the end of the file, then wait. */
  async stop() {
    if (this.stopping) return this.ended
    this.stopping = true
    clearInterval(this.watchdog)
    this.proc.stdin?.end()
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 8000)
    await this.ended
    clearTimeout(timer)
  }
}

/** ffmpeg's last words, in terms a person can act on. */
export function plainError(lines: string[]): string {
  const text = lines.join('\n')
  if (/Connection refused|Network is unreachable|No route to host|Name or service not known|getaddrinfo/i.test(text)) {
    return "The stream stopped: couldn't reach the platform. Check the internet connection and the server address."
  }
  if (/Input\/output error|Broken pipe|Connection reset|end of file|Slave muxer #\d+ failed/i.test(text)) {
    return 'The platform closed the connection.'
  }
  if (/No such file or directory|Permission denied/i.test(text)) {
    return "Couldn't write the recording. Check the recordings folder in Settings."
  }
  const last = lines.at(-1)
  return last ? `ffmpeg stopped: ${last}` : 'ffmpeg stopped unexpectedly'
}
