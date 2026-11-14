/**
 * The audio mixer, in the browser (Web Audio). Each mixer channel is:
 *
 *   device input → pick its channels → delay (sync offset) → volume → meter → program mix
 *
 * One device is opened once and shared, so an L-12 can feed one channel per
 * mic. The program mix goes into the stream and the recording.
 */
import type { AppState, AudioSource, InputDevice } from '../../../shared/state'

interface DeviceInput {
  stream: MediaStream
  node: MediaStreamAudioSourceNode
  splitter: ChannelSplitterNode
  channels: number
}

interface Chain {
  key: string
  merger: ChannelMergerNode
  delay: DelayNode
  gain: GainNode
  analyser: AnalyserNode
  buf: Float32Array<ArrayBuffer>
  /** Unhooks it from the shared device input. */
  unlink?: () => void
}

export class Mixer {
  readonly ctx: AudioContext
  readonly output: MediaStreamAudioDestinationNode
  private devices = new Map<string, Promise<DeviceInput | null>>()
  private chains = new Map<string, Chain>()
  /** Sound from a shared screen or window (desktop sound), once the person allows it. */
  private desktop: MediaStream | null = null
  /** Channels that can't play right now, with the reason (shown under the fader). */
  readonly problems = new Map<string, string>()

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' })
    this.output = this.ctx.createMediaStreamDestination()
    this.output.channelCount = 2
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume()
  }

  setDesktop(stream: MediaStream | null) {
    this.desktop = stream
    this.devices.delete('desktop')
    for (const [id, c] of this.chains) if (c.key.startsWith('desktop')) this.drop(id)
  }

  get needsDesktop() {
    return !this.desktop || !this.desktop.getAudioTracks().some((t) => t.readyState === 'live')
  }

  /** Make the mixer match the app's channels. Cheap to call on every state change. */
  update(state: AppState) {
    const wanted = new Set(state.audio.map((a) => a.id))
    for (const id of [...this.chains.keys()]) if (!wanted.has(id)) this.drop(id)
    for (const a of state.audio) {
      const device = this.deviceFor(a, state.inputs)
      const key = `${a.kind}|${device ?? ''}|${a.channels?.join(',') ?? ''}`
      let chain = this.chains.get(a.id)
      if (chain && chain.key !== key) {
        this.drop(a.id)
        chain = undefined
      }
      if (!chain) chain = this.build(a, key, device)
      const t = this.ctx.currentTime
      chain.gain.gain.setTargetAtTime(a.muted ? 0 : a.volume, t, 0.02)
      chain.delay.delayTime.setTargetAtTime(Math.max(0, a.syncOffsetMs ?? 0) / 1000, t, 0.05)
    }
    // Close devices nobody uses any more (frees the L-12 for other apps).
    const used = new Set(state.audio.map((a) => this.deviceFor(a, state.inputs) ?? ''))
    for (const id of [...this.devices.keys()]) {
      if (!used.has(id) && id !== 'desktop') {
        void this.devices.get(id)?.then((d) => d?.stream.getTracks().forEach((t) => t.stop()))
        this.devices.delete(id)
      }
    }
  }

  /** Peak level per channel, 0 to 1, for the meters. */
  levels(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [id, c] of this.chains) {
      c.analyser.getFloatTimeDomainData(c.buf)
      let peak = 0
      for (const v of c.buf) peak = Math.max(peak, Math.abs(v))
      out[id] = Math.min(1, peak)
    }
    return out
  }

  private deviceFor(a: AudioSource, inputs: AppState['inputs']): string | undefined {
    if (a.kind === 'desktop') return 'desktop'
    if (a.kind === 'video') {
      // A capture device's sound is the audio input from the same box (same group).
      const v = inputs.video.find((d) => d.id === a.device)
      return inputs.audio.find((d: InputDevice) => v?.group && d.group === v.group)?.id
    }
    return a.device || 'default'
  }

  private openDevice(id: string): Promise<DeviceInput | null> {
    let p = this.devices.get(id)
    if (p) return p
    p = (async () => {
      let stream: MediaStream
      if (id === 'desktop') {
        if (!this.desktop) return null
        stream = this.desktop
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: id === 'default' ? undefined : { exact: id },
            channelCount: { ideal: 32 },
            sampleRate: 48000,
            // A mixer passes sound through untouched; voice-call processing would ruin music and room mics.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        })
      }
      const node = this.ctx.createMediaStreamSource(stream)
      const channels = Math.max(1, node.channelCount, stream.getAudioTracks()[0]?.getSettings().channelCount ?? 2)
      node.channelCountMode = 'explicit'
      node.channelCount = channels
      node.channelInterpretation = 'discrete'
      const splitter = this.ctx.createChannelSplitter(channels)
      node.connect(splitter)
      return { stream, node, splitter, channels }
    })().catch(() => null)
    this.devices.set(id, p)
    return p
  }

  private build(a: AudioSource, key: string, device: string | undefined): Chain {
    const merger = this.ctx.createChannelMerger(2)
    const delay = this.ctx.createDelay(5)
    const gain = this.ctx.createGain()
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 1024
    merger.connect(delay).connect(gain).connect(analyser)
    gain.connect(this.output)
    const chain: Chain = { key, merger, delay, gain, analyser, buf: new Float32Array(analyser.fftSize) }
    this.chains.set(a.id, chain)
    this.problems.delete(a.id)
    if (!device) {
      this.problems.set(a.id, a.kind === 'video' ? 'No sound found for this video input' : 'Pick a device')
      return chain
    }
    void this.openDevice(device).then((d) => {
      if (this.chains.get(a.id) !== chain) return
      if (!d) {
        this.problems.set(a.id, device === 'desktop' ? 'Needs a click to share desktop sound' : 'Could not open the device')
        return
      }
      // Pick the channels: one input goes to both sides; a pair goes left and right.
      const [l, r] = (a.channels ?? (d.channels >= 2 ? [1, 2] : [1])).map((c) => Math.min(c, d.channels) - 1)
      d.splitter.connect(merger, l, 0)
      d.splitter.connect(merger, r ?? l, 1)
      chain.unlink = () => {
        try {
          d.splitter.disconnect(merger)
        } catch {
          // already gone
        }
      }
    })
    return chain
  }

  private drop(id: string) {
    const c = this.chains.get(id)
    if (!c) return
    c.unlink?.()
    c.merger.disconnect()
    c.gain.disconnect()
    this.chains.delete(id)
    this.problems.delete(id)
  }

  close() {
    for (const p of this.devices.values()) void p.then((d) => d?.stream.getTracks().forEach((t) => t.stop()))
    void this.ctx.close()
  }
}
