/**
 * Sends the Live picture and the program sound to the app's server, which
 * hands them to ffmpeg for the stream or the recording. The browser does a
 * first, high-quality encode (MediaRecorder); ffmpeg makes the final one.
 */
import type { QualityPreset } from '../../../shared/presets'

/** Best format this browser can make: H.264 when it can (the recording keeps it as is), else VP8. */
function pickFormat(): { mimeType: string; codec: string } {
  const options = [
    { mimeType: 'video/webm;codecs=h264,opus', codec: 'h264' },
    { mimeType: 'video/webm;codecs=avc1,opus', codec: 'h264' },
    { mimeType: 'video/webm;codecs=vp9,opus', codec: 'vp9' },
    { mimeType: 'video/webm;codecs=vp8,opus', codec: 'vp8' }
  ]
  return options.find((o) => MediaRecorder.isTypeSupported(o.mimeType)) ?? { mimeType: 'video/webm', codec: 'vp8' }
}

/** Must match MEDIA_RECONNECT_CODE on the server: "the stream dropped, start again after a pause". */
const RECONNECT_CODE = 4010

export class Output {
  private ws: WebSocket | null = null
  private rec: MediaRecorder | null = null
  private closed = false
  private retry?: ReturnType<typeof setTimeout>

  constructor(
    readonly kind: 'stream' | 'record',
    private readonly media: MediaStream,
    private readonly preset: QualityPreset,
    private readonly onProblem: (message: string) => void
  ) {
    this.connect()
  }

  /** Open a connection and start a fresh encode (each ffmpeg run needs the start of the file). */
  private connect() {
    const { mimeType, codec } = pickFormat()
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/media?kind=${this.kind}&codec=${codec}`)
    ws.binaryType = 'arraybuffer'
    let rec: MediaRecorder | null = null
    this.ws = ws
    ws.onopen = () => {
      // Twice the platform bitrate: ffmpeg re-encodes the stream, and the recording keeps this.
      rec = new MediaRecorder(this.media, {
        mimeType,
        videoBitsPerSecond: this.preset.videoKbps * 2000,
        audioBitsPerSecond: 192_000
      })
      this.rec = rec
      rec.ondataavailable = async (e) => {
        const data = e.data.size > 0 ? await e.data.arrayBuffer() : null
        if (data && ws.readyState === WebSocket.OPEN) ws.send(data)
        if (rec?.state === 'inactive') ws.close()
      }
      rec.onerror = () => this.onProblem('The browser stopped encoding the video')
      rec.start(250)
    }
    ws.onclose = (e) => {
      if (rec?.state === 'recording') rec.stop()
      if (this.closed || this.ws !== ws) return
      if (e.code === RECONNECT_CODE) {
        // The connection to the platform dropped: the app asks for a fresh start after a pause.
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

  /** Stop: the last piece is sent, then the connection closes and ffmpeg finishes. */
  stop() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.retry)
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop()
    else this.ws?.close()
  }
}
