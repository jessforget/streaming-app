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

/** H.264 High profile, level picked for the size and frame rate. */
export function avcCodec(p: QualityPreset): string {
  const mbps = (Math.ceil(p.width / 16) * Math.ceil(p.height / 16) * p.fps) / 1000
  const level = mbps <= 108 ? '1f' : mbps <= 245.76 ? '28' : '2a' // 3.1, 4.0, 4.2
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
  /** Audio: where its own clock starts on ours, and how many samples have gone in. */
  private audioBase: { theirs: number; ours: number } | null = null
  private failed = false
  private sent = 0

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
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => this.fail(`The graphics card stopped encoding the video (${e.message})`)
    })
    this.video.configure(videoConfig(preset))
    if (audio) this.startAudio(audio, sampleRate)
  }

  frame(canvas: HTMLCanvasElement) {
    if (this.failed || this.video.state !== 'configured') return
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
        if (!this.audioBase) return
        // Move the sound's own clock onto the picture's clock.
        const ts = chunk.timestamp - this.audioBase.theirs + this.audioBase.ours
        if (ts < 0) return
        this.muxer.addAudioChunk(chunk, meta, ts)
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
        if (!this.audioBase) this.audioBase = { theirs: value.timestamp, ours: Math.round((performance.now() - this.t0) * 1000) }
        if (value.sampleRate !== sampleRate || value.numberOfChannels !== 2) {
          // The mixer runs at 48 kHz stereo; anything else would need resampling here.
          value.close()
          if (!this.failed) this.fail(`The sound runs at ${value.sampleRate} Hz with ${value.numberOfChannels} channels; the app needs 48000 Hz stereo.`)
          return
        }
        enc.encode(value)
        value.close()
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
