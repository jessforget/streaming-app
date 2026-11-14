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

export class Output {
  private ws: WebSocket
  private rec: MediaRecorder | null = null
  private closed = false

  constructor(
    readonly kind: 'stream' | 'record',
    media: MediaStream,
    preset: QualityPreset,
    onProblem: (message: string) => void
  ) {
    const { mimeType, codec } = pickFormat()
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.ws = new WebSocket(`${proto}//${location.host}/media?kind=${kind}&codec=${codec}`)
    this.ws.binaryType = 'arraybuffer'
    this.ws.onopen = () => {
      // Twice the platform bitrate: ffmpeg re-encodes the stream, and the recording keeps this.
      this.rec = new MediaRecorder(media, {
        mimeType,
        videoBitsPerSecond: preset.videoKbps * 2000,
        audioBitsPerSecond: 192_000
      })
      this.rec.ondataavailable = async (e) => {
        const data = e.data.size > 0 ? await e.data.arrayBuffer() : null
        if (data && this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
        if (this.rec?.state === 'inactive') this.ws.close()
      }
      this.rec.onerror = () => onProblem('The browser stopped encoding the video')
      this.rec.start(250)
    }
    this.ws.onclose = () => {
      if (!this.closed) {
        this.closed = true
        if (this.rec?.state === 'recording') this.rec.stop()
      }
    }
    this.ws.onerror = () => onProblem(`Could not send the video to the app for the ${kind === 'stream' ? 'stream' : 'recording'}`)
  }

  /** Stop: the last piece is sent, then the connection closes and ffmpeg finishes. */
  stop() {
    if (this.closed) return
    this.closed = true
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop()
    else this.ws.close()
  }
}
