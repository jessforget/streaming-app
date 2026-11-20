/**
 * Sends the Live picture and the program sound to the app's server, encoded
 * once, on the graphics card (WebCodecs, NVENC on an NVIDIA card).
 *
 * The picture is made exactly as the platforms want it (size, frame rate,
 * constant bitrate, a keyframe every 2 seconds), so ffmpeg passes it on as it
 * is. The sound is Opus here; ffmpeg turns it into AAC, which costs little.
 */
import { Muxer, StreamTarget } from 'webm-muxer'
import type { QualityPreset } from '../../../shared/presets'

/** Must match READY_CODEC on the server. */
const READY_CODEC = 'h264gpu'
/** Must match MEDIA_RECONNECT_CODE on the server. */
const RECONNECT_CODE = 4010
/** Frames waiting in the encoder before new ones are skipped (like OBS's "skipped frames"). */
const MAX_QUEUE = 6

/** H.264 High profile, level picked for the size, frame rate and bitrate (high-quality recordings need a higher level). */
export function avcCodec(p: QualityPreset): string {
  const mbps = (Math.ceil(p.width / 16) * Math.ceil(p.height / 16) * p.fps) / 1000
  // [level, most macroblocks a second (thousands), most kbps in High profile]
  const levels: [string, number, number][] = [
    ['1f', 108, 17_500], // 3.1
    ['28', 245.76, 31_250], // 4.0
    ['2a', 522.24, 62_500] // 4.2
  ]
  const level = levels.find(([, mb, kbps]) => mbps <= mb && p.videoKbps <= kbps)?.[0] ?? '2a'
  return `avc1.6400${level}`
}

/** ?encode=any in the address also allows encoding on the processor (for testing on a PC without a usable card). */
const anyEncoder = typeof location !== 'undefined' && new URLSearchParams(location.search).get('encode') === 'any'

export function videoConfig(p: QualityPreset): VideoEncoderConfig {
  return {
    codec: avcCodec(p),
    width: p.width,
    height: p.height,
    framerate: p.fps,
    bitrate: p.videoKbps * 1000,
    bitrateMode: 'constant',
    latencyMode: 'realtime',
    hardwareAcceleration: anyEncoder ? 'no-preference' : 'prefer-hardware',
    avc: { format: 'avc' }
  }
}

/** Whether this browser can encode the preset on the graphics card. */
export async function gpuEncodeSupported(p: QualityPreset): Promise<boolean> {
  if (!('VideoEncoder' in window) || !('AudioEncoder' in window) || !('MediaStreamTrackProcessor' in window)) return false
  try {
    const r = await VideoEncoder.isConfigSupported(videoConfig(p))
    return !!r.supported
  } catch {
    return false
  }
}

declare class MediaStreamTrackProcessor<T> {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<T>
}

export class GpuOutput {
  /** Frames skipped because the encoder was still busy. */
  skipped = 0
  private ws: WebSocket | null = null
  private closed = false
  private retry?: ReturnType<typeof setTimeout>
  private run: Run | null = null

  constructor(
    readonly kind: 'stream' | 'record',
    private readonly canvas: HTMLCanvasElement,
    private readonly audio: MediaStreamTrack | undefined,
    private readonly preset: QualityPreset,
    private readonly onProblem: (message: string) => void
  ) {
    this.connect()
  }

  /** The studio drew a new Live frame: encode it. */
  pushFrame() {
    this.run?.frame(this.canvas)
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/media?kind=${this.kind}&codec=${READY_CODEC}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      try {
        this.run = new Run(ws, this.preset, this.audio, (m) => this.onProblem(m), () => this.skipped++)
      } catch (e) {
        this.onProblem(`Could not start the graphics card's video encoder (${(e as Error).message})`)
        this.closed = true
        ws.close()
      }
    }
    ws.onclose = (e) => {
      const run = this.run
      this.run = null
      void run?.close()
      if (this.closed || this.ws !== ws) return
      if (e.code === RECONNECT_CODE) {
        const wait = Number(e.reason) || 2000
        this.retry = setTimeout(() => {
          if (!this.closed) this.connect()
        }, wait)
        return
      }
      this.closed = true
    }
    ws.onerror = () => this.onProblem(`Could not send the video to the app for the ${this.kind === 'stream' ? 'stream' : 'recording'}`)
  }

  /** Stop: the encoders finish, the last piece is sent, then the connection closes and ffmpeg finishes. */
  stop() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.retry)
    const run = this.run
    const ws = this.ws
    this.run = null
    if (run) void run.close().then(() => ws?.close())
    else ws?.close()
  }
}

/** One connection's worth of encoding: a fresh file (header, keyframe first) for each ffmpeg run. */
class Run {
  private muxer: Muxer<StreamTarget>
  private video: VideoEncoder
  private audioEnc: AudioEncoder | null = null
  private reader: ReadableStreamDefaultReader<AudioData> | null = null
  private readonly t0 = performance.now()
  private frames = 0
  private lastTs = -1
  /**
   * Where the next piece of sound goes, on the picture's clock (µs). The file only goes out once it has
   * both picture and sound up to a point, so sound must never stop: when none comes from the mixer
   * (sound blocked by the browser, a stuck device), silence fills in. Before this, no sound meant no
   * stream at all, while the app still looked live.
   */
  private audioNext: number | null = null
  private readonly sampleRate = 48000
  private failed = false
  private sent = 0
  /** For the log: what went in and came out, to see which part is stuck. */
  private stats = { videoOut: 0, audioIn: 0, audioOut: 0, silenceMs: 0, software: false }
  private diagTimers: ReturnType<typeof setTimeout>[] = []

  constructor(
    private readonly ws: WebSocket,
    private readonly preset: QualityPreset,
    audio: MediaStreamTrack | undefined,
    private readonly onProblem: (m: string) => void,
    private readonly onSkip: () => void
  ) {
    const sampleRate = 48000
    this.muxer = new Muxer({
      target: new StreamTarget({
        // In streaming mode the muxer only ever appends, so each piece goes out in order.
        onData: (data, position) => {
          if (position !== this.sent) console.warn(`[output] muxer wrote at ${position}, expected ${this.sent}`)
          this.sent = position + data.byteLength
          if (ws.readyState === WebSocket.OPEN) ws.send(data)
        }
      }),
      type: 'matroska',
      streaming: true,
      firstTimestampBehavior: 'permissive',
      video: { codec: 'V_MPEG4/ISO/AVC', width: preset.width, height: preset.height, frameRate: preset.fps },
      audio: audio ? { codec: 'A_OPUS', numberOfChannels: 2, sampleRate } : undefined
    })
    this.video = new VideoEncoder({
      output: (chunk, meta) => {
        this.stats.videoOut++
        this.muxer.addVideoChunk(chunk, meta)
      },
      error: (e) => this.fail(`The graphics card stopped encoding the video (${e.message})`)
    })
    this.video.configure(videoConfig(preset))
    if (audio) this.startAudio(audio, sampleRate)
    this.diagTimers.push(setTimeout(() => this.diag('after 3s'), 3000), setTimeout(() => this.diag('after 10s'), 10_000))
  }

  /** A note for app.log (a text message; the server keeps it out of the video). */
  private diag(when: string) {
    if (this.ws.readyState !== WebSocket.OPEN) return
    const s = this.stats
    this.ws.send(
      `${when}: frames in ${this.frames}, video out ${s.videoOut}${s.software ? ' (processor encoder)' : ''}, queue ${this.video.encodeQueueSize}, ` +
        `sound in ${s.audioIn}, sound out ${s.audioOut}, silence filled ${s.silenceMs} ms, sent ${Math.round(this.sent / 1024)} KB`
    )
  }

  private nowUs() {
    return Math.round((performance.now() - this.t0) * 1000)
  }

  /** Put sound (one Float32Array per channel) on the timeline, right after the last piece. */
  private encodeAudio(planes: Float32Array[], frames: number) {
    const enc = this.audioEnc
    if (!enc || enc.state !== 'configured' || frames <= 0) return
    const ts = this.audioNext ?? this.nowUs()
    const data = new Float32Array(frames * planes.length)
    planes.forEach((p, i) => data.set(p.subarray(0, frames), i * frames))
    const ad = new AudioData({ format: 'f32-planar', sampleRate: this.sampleRate, numberOfFrames: frames, numberOfChannels: planes.length, timestamp: ts, data })
    enc.encode(ad)
    ad.close()
    this.audioNext = ts + Math.round((frames * 1e6) / this.sampleRate)
  }

  /** No sound from the mixer lately: fill the gap with silence so the picture is not held back. */
  private fillSilence() {
    if (!this.audioEnc || this.audioEnc.state !== 'configured') return
    const now = this.nowUs()
    const next = this.audioNext ?? 0
    if (next > now - 300_000) return
    let gap = Math.round(((now - 100_000 - next) * this.sampleRate) / 1e6)
    // A long gap (the window was frozen): don't make minutes of silence, just move on.
    if (gap > this.sampleRate * 2) {
      this.audioNext = now - 100_000
      gap = Math.round(this.sampleRate / 10)
    }
    this.stats.silenceMs += Math.round((gap * 1000) / this.sampleRate)
    const block = 4800
    while (gap > 0) {
      const n = Math.min(block, gap)
      this.encodeAudio([new Float32Array(n), new Float32Array(n)], n)
      gap -= n
    }
  }

  frame(canvas: HTMLCanvasElement) {
    if (this.failed || this.video.state !== 'configured') return
    this.fillSilence()
    // Frames go in but nothing comes out: the graphics card's encoder is stuck. Try the processor once.
    if (!this.stats.software && this.stats.videoOut === 0 && this.frames > this.preset.fps * 4) {
      this.stats.software = true
      this.diag('graphics card encoder gave nothing in 4s, switching to the processor')
      this.video.reset()
      this.video.configure({ ...videoConfig(this.preset), hardwareAcceleration: 'prefer-software' })
      this.frames = 0
    }
    if (this.video.encodeQueueSize > MAX_QUEUE) {
      this.onSkip()
      return
    }
    // Real time since the start, so the picture stays with the sound even when a frame is skipped.
    let ts = Math.round((performance.now() - this.t0) * 1000)
    if (ts <= this.lastTs) ts = this.lastTs + 1
    this.lastTs = ts
    const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / this.preset.fps) })
    // A keyframe every 2 seconds, as YouTube, Facebook and Instagram ask for.
    this.video.encode(frame, { keyFrame: this.frames % (this.preset.fps * 2) === 0 })
    frame.close()
    this.frames++
  }

  private startAudio(track: MediaStreamTrack, sampleRate: number) {
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        // Already on the picture's clock (encodeAudio stamps it).
        if (chunk.timestamp < 0) return
        this.stats.audioOut++
        this.muxer.addAudioChunk(chunk, meta)
      },
      error: (e) => this.fail(`The sound encoder stopped (${e.message})`)
    })
    enc.configure({ codec: 'opus', sampleRate, numberOfChannels: 2, bitrate: 192_000 })
    this.audioEnc = enc
    const reader = new MediaStreamTrackProcessor<AudioData>({ track: track.clone() }).readable.getReader()
    this.reader = reader
    const pump = async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }))
        if (done || !value) return
        if (this.failed || enc.state !== 'configured') {
          value.close()
          continue
        }
        if (value.sampleRate !== sampleRate) {
          // The mixer runs at 48 kHz; anything else would need resampling here.
          value.close()
          if (!this.failed) this.fail(`The sound runs at ${value.sampleRate} Hz; the app needs 48000 Hz.`)
          return
        }
        this.stats.audioIn++
        const frames = value.numberOfFrames
        const planes: Float32Array[] = []
        for (let c = 0; c < 2; c++) {
          // Mono sound goes to both sides.
          const p = new Float32Array(frames)
          value.copyTo(p, { planeIndex: Math.min(c, value.numberOfChannels - 1), format: 'f32-planar' })
          planes.push(p)
        }
        value.close()
        // Way ahead of the picture (silence filled in just before this sound arrived): skip it to stay in sync.
        if (this.audioNext !== null && this.audioNext > this.nowUs() + 300_000) continue
        this.encodeAudio(planes, frames)
      }
    }
    void pump()
  }

  private fail(message: string) {
    if (this.failed) return
    this.failed = true
    this.onProblem(message)
    this.ws.close()
  }

  /** Finish the encoders and send what is left. */
  async close() {
    this.diagTimers.forEach(clearTimeout)
    await this.reader?.cancel().catch(() => {})
    try {
      if (this.video.state === 'configured') await this.video.flush()
      if (this.audioEnc?.state === 'configured') await this.audioEnc.flush()
      this.muxer.finalize()
    } catch {
      // stopping anyway
    }
    if (this.video.state !== 'closed') this.video.close()
    if (this.audioEnc && this.audioEnc.state !== 'closed') this.audioEnc.close()
  }
}
