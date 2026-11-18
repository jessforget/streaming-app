/**
 * The audio mixer, in the browser (Web Audio). Each mixer channel is:
 *
 *   device input → pick its channels → delay (sync offset) → volume → meter → program mix
 *
 * One device is opened once and shared, so an L-12 can feed one channel per
 * mic. The program mix goes into the stream and the recording.
 */
import { TONE_GAIN, TONE_HZ } from '../../../shared/bars'
import { BREAK_SOUND, COMMERCIALS_CHANNEL, audible, scenesOnAir, type AppState, type AudioSource, type InputDevice, type Layer } from '../../../shared/state'
import { fileUrl } from './compositor'
import { PHONE_PREFIX } from './phones'

/** Close a device input: stop a device, pause a file. A phone's tracks belong to its connection, so they stay. */
const stopTracks = (id: string, d: DeviceInput | null) => {
  if (d?.el) {
    d.el.pause()
    d.node.disconnect()
    return
  }
  // A video's sound node is shared by every channel that opens it (one node per element): unhook only this one.
  if (d?.node instanceof OscillatorNode) d.node.stop()
  if (d && !d.stream) {
    try {
      d.node.disconnect(d.splitter)
    } catch {
      // not hooked up
    }
  }
  if (!id.startsWith(PHONE_PREFIX) && !id.startsWith(GFX_DEVICE)) d?.stream?.getTracks().forEach((t) => t.stop())
}

/** Sound from a video file in a scene ("media" source with sound on), keyed by layer id. */
const LAYER_PREFIX = 'mediasound-'
/** Sound from a network graphics page (a video in the gfx app), keyed by layer id. */
export const GFX_SOUND_PREFIX = 'gfxsound-'
const GFX_DEVICE = 'gfx:'
/** The line-up tone of a Color bars source, keyed by layer id. */
const TONE_PREFIX = 'bartone-'
/** Mixer device for a network camera's sound: this, then its video device id ("net:..."). */
const NET_SOUND = 'netsound:'
/** How many times (a second apart) to try a video's sound before saying it can't. */
const RETRIES = 20
const TONE_DEVICE = 'tone:'

interface DeviceInput {
  stream?: MediaStream
  /** A music or sound file plays through this element. */
  el?: HTMLAudioElement
  node: AudioNode
  splitter: ChannelSplitterNode
  channels: number
}

interface Chain {
  key: string
  merger: ChannelMergerNode
  delay: DelayNode
  gain: GainNode
  /** Opens while the channel's scene is on air; fades with the transition. */
  gate: GainNode
  open: boolean
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
  /** Where phone microphones come from (set by the studio). */
  phoneStream: (id: string) => MediaStream | null = () => null
  /** The sound a network graphics source's page sends, if any (set by the studio). */
  graphicsStream: (layer: Layer) => MediaStream | null = () => null
  /** A video a source's page handed over, playing here (set by the studio). */
  graphicsVideo: (layer: Layer) => { n: number; el: HTMLVideoElement; sound: boolean } | null = () => null
  /** Remote WebRTC sound only flows into Web Audio while something plays it: a silent element per stream. */
  private pullers = new Map<string, HTMLAudioElement>()
  /** The playing element of a video file in a scene (set by the studio). */
  mediaElement: (url: string) => HTMLVideoElement | null = () => null
  /** A media element can feed Web Audio only once: keep its node. */
  private mediaNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
  private onAir = new Set<string>()
  private state: AppState | null = null

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' })
    this.output = this.ctx.createMediaStreamDestination()
    this.output.channelCount = 2
    // Everything heard goes through one bus: to the stream, and (when listening) to headphones.
    this.bus = this.ctx.createGain()
    this.bus.connect(this.output)
    this.monitorGain = this.ctx.createGain()
    this.monitorGain.gain.value = 0
    this.monitorOut = this.ctx.createMediaStreamDestination()
    // Listening hears the whole stream (busTap), or one channel alone (soloTap).
    this.busTap = this.ctx.createGain()
    this.soloTap = this.ctx.createGain()
    this.bus.connect(this.busTap).connect(this.monitorGain)
    this.soloTap.connect(this.monitorGain)
    this.monitorGain.connect(this.monitorOut)
    // Left and right of what goes out, for the stream meter.
    const split = this.ctx.createChannelSplitter(2)
    this.bus.connect(split)
    for (let i = 0; i < 2; i++) {
      const a = this.ctx.createAnalyser()
      a.fftSize = 1024
      split.connect(a, i)
      this.sides.push({ a, buf: new Float32Array(a.fftSize) })
    }
  }

  private readonly busTap: GainNode
  private readonly soloTap: GainNode
  private readonly sides: { a: AnalyserNode; buf: Float32Array<ArrayBuffer> }[] = []
  /** The one channel heard alone while listening, or null for the whole stream. */
  solo: string | null = null
  private soloed: GainNode | null = null
  private monitorListeners = new Set<() => void>()

  /** Network cameras' sound, by device id: where it plays into, and when the next piece starts. */
  private netSound = new Map<string, { node: GainNode; next: number }>()

  /** A piece of a network camera's sound (48 kHz stereo, L R L R...). Played a little behind, evenly. */
  pushNetSound(deviceId: string, pcm: Int16Array) {
    const s = this.netSound.get(deviceId)
    const frames = pcm.length >> 1
    if (!s || !frames || this.ctx.state !== 'running') return
    const buf = this.ctx.createBuffer(2, frames, 48000)
    const l = buf.getChannelData(0)
    const r = buf.getChannelData(1)
    for (let i = 0; i < frames; i++) {
      l[i] = pcm[2 * i] / 32768
      r[i] = pcm[2 * i + 1] / 32768
    }
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(s.node)
    const t = this.ctx.currentTime
    // Fell behind (a gap) or too far ahead (a burst): start again 0.12 s behind now.
    if (s.next < t + 0.01 || s.next > t + 0.6) s.next = t + 0.12
    src.start(s.next)
    s.next += frames / 48000
  }

  /** Peak of the stream's left and right, 0 to 1. */
  streamLevels(): [number, number] {
    const out = this.sides.map(({ a, buf }) => {
      a.getFloatTimeDomainData(buf)
      let p = 0
      for (const v of buf) p = Math.max(p, Math.abs(v))
      return p
    })
    return [out[0] ?? 0, out[1] ?? 0]
  }

  /** Called when listening changes (on/off, output, the channel heard alone). */
  onMonitor(fn: () => void) {
    this.monitorListeners.add(fn)
    return () => void this.monitorListeners.delete(fn)
  }

  /** Hear one channel alone (null: the whole stream again). Turns listening on. */
  async setSolo(id: string | null) {
    this.solo = id
    this.linkSolo()
    this.busTap.gain.setTargetAtTime(id ? 0 : 1, this.ctx.currentTime, 0.02)
    await this.setMonitor(id ? { on: true } : {})
  }

  /** Wire the channel heard alone to the headphones (again after its chain is rebuilt). */
  private linkSolo() {
    const want = this.solo ? (this.chains.get(this.solo)?.gain ?? null) : null
    if (want === this.soloed) return
    try {
      this.soloed?.disconnect(this.soloTap)
    } catch {
      // already gone
    }
    this.soloed = want
    want?.connect(this.soloTap)
  }

  private readonly bus: GainNode
  private readonly monitorGain: GainNode
  private readonly monitorOut: MediaStreamAudioDestinationNode
  private monitorEl: HTMLAudioElement | null = null
  /** Listening to the stream's sound on this PC, and on which output (a device id, '' = Windows' default). */
  monitor = { on: false, device: '', volume: 0.8 }

  /** Hear what goes out to the stream, on headphones or speakers; it never changes the stream itself. */
  async setMonitor(m: Partial<{ on: boolean; device: string; volume: number }>) {
    this.monitor = { ...this.monitor, ...m }
    const { on, device, volume } = this.monitor
    this.monitorGain.gain.setTargetAtTime(on ? volume : 0, this.ctx.currentTime, 0.03)
    if (on && !this.monitorEl) {
      const el = new Audio()
      el.srcObject = this.monitorOut.stream
      this.monitorEl = el
    }
    const el = this.monitorEl
    if (!el) {
      for (const fn of this.monitorListeners) fn()
      return
    }
    const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string }
    if (sink.setSinkId && sink.sinkId !== device) await sink.setSinkId(device)
    try {
      if (on) await el.play()
      else el.pause()
    } finally {
      for (const fn of this.monitorListeners) fn()
    }
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume()
  }

  setDesktop(stream: MediaStream | null) {
    this.desktop = stream
    this.devices.delete('desktop')
    for (const [id, c] of this.chains) if (c.key.startsWith('desktop')) this.drop(id)
  }

  /** A phone connected again or left: open its sound afresh on the next update. */
  refreshPhones() {
    for (const id of [...this.devices.keys()]) if (id.startsWith(PHONE_PREFIX)) this.devices.delete(id)
    for (const [id, c] of this.chains) if (c.key.includes(`|${PHONE_PREFIX}`)) this.drop(id)
  }

  /** A graphics page started or stopped sending its sound: open it afresh on the next update. */
  refreshGraphics() {
    for (const id of [...this.devices.keys()]) if (id.startsWith(GFX_DEVICE)) this.devices.delete(id)
    for (const [id, c] of this.chains) if (c.key.includes(`|${GFX_DEVICE}`)) this.drop(id)
    for (const el of this.pullers.values()) el.srcObject = null
    this.pullers.clear()
  }

  get needsDesktop() {
    return !this.desktop || !this.desktop.getAudioTracks().some((t) => t.readyState === 'live')
  }

  /** Make the mixer match the app's channels. Cheap to call on every state change. */
  update(state: AppState) {
    this.state = state
    const onAir = scenesOnAir(state)
    const sceneChanged = [...onAir].some((id) => !this.onAir.has(id)) || [...this.onAir].some((id) => !onAir.has(id))
    this.onAir = onAir
    // Sound follows the picture: a fade takes as long as the video fade; a cut is quick but not a click.
    const fadeS = state.transition.kind === 'fade' ? Math.max(0.03, state.transition.durationMs / 1000) : 0.03

    const channels = [...state.audio.map((a) => ({ a, on: audible(a, onAir) })), ...this.mediaChannels(state, onAir), ...this.graphicsChannels(state, onAir), ...this.toneChannels(state, onAir)]
    // A commercial break on Live: only its videos' sound. Every channel of the Sound panel goes off.
    const brk = state.scenes.find((s) => s.commercial)
    const inBreak = !!brk && state.programSceneId === brk.id && brk.layers.some((l) => l.kind === 'media')
    const micGain = inBreak ? 0 : 1
    const wanted = new Set(channels.map((c) => c.a.id))
    for (const id of [...this.chains.keys()]) if (!wanted.has(id)) this.drop(id)
    for (const { a, on } of channels) {
      const device = this.deviceFor(a, state.inputs)
      const key = `${a.kind}|${device ?? ''}|${a.channels?.join(',') ?? ''}`
      let chain = this.chains.get(a.id)
      if (chain && chain.key !== key) {
        this.drop(a.id)
        chain = undefined
      }
      const fresh = !chain
      if (!chain) chain = this.build(a, key, device)
      const t = this.ctx.currentTime
      const channel = state.audio.includes(a)
      const level = a.muted ? 0 : a.volume * (channel ? micGain : 1)
      // Channels follow the break with the Transition's fade; a fader move is quick.
      chain.gain.gain.setTargetAtTime(level, t, channel && sceneChanged ? fadeS / 3 : 0.02)
      chain.delay.delayTime.setTargetAtTime(Math.max(0, a.syncOffsetMs ?? 0) / 1000, t, 0.05)
      if (fresh || chain.open !== on || sceneChanged) {
        const opening = on && !chain.open
        chain.open = on
        chain.gate.gain.cancelScheduledValues(t)
        if (fresh) chain.gate.gain.setValueAtTime(on ? 1 : 0, t)
        else chain.gate.gain.setTargetAtTime(on ? 1 : 0, t, fadeS / 3)
        if (a.kind === 'file' && device) this.playFile(device, a, on, opening || fresh, fadeS)
      }
      if (a.kind === 'file' && device) void this.devices.get(device)?.then((d) => d?.el && (d.el.loop = a.loop !== false))
    }
    if (this.solo && !wanted.has(this.solo)) void this.setSolo(null)
    else this.linkSolo()
    // Close devices nobody uses any more (frees the L-12 for other apps).
    const used = new Set(channels.map(({ a }) => this.deviceFor(a, state.inputs) ?? ''))
    for (const id of [...this.devices.keys()]) {
      if (!used.has(id) && id !== 'desktop') {
        if (id.startsWith(NET_SOUND)) this.netSound.delete(id.slice(NET_SOUND.length))
        void this.devices.get(id)?.then((d) => stopTracks(id, d))
        this.devices.delete(id)
      }
    }
  }

  /** Video files with their sound on, in any scene: each is a channel that is heard while its scene is on air. */
  private mediaChannels(state: AppState, onAir: Set<string>): { a: AudioSource; on: boolean }[] {
    const out: { a: AudioSource; on: boolean }[] = []
    for (const scene of state.scenes) {
      if (scene.commercial) {
        // A commercial break: one channel, playing the sound of the video showing now.
        const media = scene.layers.filter((l) => l.kind === 'media' && l.url)
        const now = media.find((l) => l.visible) ?? media[0]
        if (!now || now.sound === false) continue
        const bs = { ...BREAK_SOUND, ...scene.breakSound }
        out.push({
          a: { id: COMMERCIALS_CHANNEL, name: 'Commercials', kind: 'file', url: now.url, syncOffsetMs: 0, volume: bs.volume, muted: bs.muted, level: 0 },
          on: onAir.has(scene.id)
        })
        continue
      }
      for (const l of scene.layers) {
        if (l.kind !== 'media' || !l.sound || !l.url) continue
        out.push({
          a: { id: LAYER_PREFIX + l.id, name: l.name, kind: 'file', url: l.url, syncOffsetMs: 0, volume: l.volume ?? 1, muted: false, level: 0 },
          on: l.visible && onAir.has(scene.id)
        })
      }
    }
    return out
  }

  /** Color bars with their tone on: a 1 kHz tone, heard while their scene is on air. */
  private toneChannels(state: AppState, onAir: Set<string>): { a: AudioSource; on: boolean }[] {
    const out: { a: AudioSource; on: boolean }[] = []
    for (const scene of state.scenes) {
      for (const l of scene.layers) {
        if (l.kind !== 'bars' || !l.sound) continue
        out.push({
          a: { id: TONE_PREFIX + l.id, name: `${l.name} (tone)`, kind: 'device', device: `${TONE_DEVICE}${TONE_HZ}`, syncOffsetMs: 0, volume: (l.volume ?? 1) * TONE_GAIN, muted: false, level: 0 },
          on: l.visible && onAir.has(scene.id)
        })
      }
    }
    return out
  }

  /** Network graphics sources whose page sends sound (videos in the gfx app): heard while on air. */
  private graphicsChannels(state: AppState, onAir: Set<string>): { a: AudioSource; on: boolean }[] {
    const out: { a: AudioSource; on: boolean }[] = []
    const seen = new Set<string>()
    for (const scene of state.scenes) {
      for (const l of scene.layers) {
        if (l.kind !== 'graphics' || l.sound === false || seen.has(l.id)) continue
        // A video the page handed over plays here: its sound comes from that. Otherwise, the sound the page sends.
        const video = this.graphicsVideo(l)
        const stream = video ? null : this.graphicsStream(l)
        let device: string
        if (video) {
          if (!video.sound) continue
          device = `${GFX_DEVICE}video:${video.n}`
        } else if (stream?.getAudioTracks().length) device = GFX_DEVICE + stream.id
        else continue
        seen.add(l.id)
        out.push({
          a: { id: GFX_SOUND_PREFIX + l.id, name: `${l.name} (sound)`, kind: 'device', device, syncOffsetMs: 0, volume: l.volume ?? 1, muted: false, level: 0 },
          on: l.visible && onAir.has(scene.id)
        })
      }
    }
    return out
  }

  /** A music file starts from the top when its scene goes on air, and pauses once it has faded out. */
  private playFile(device: string, a: AudioSource, on: boolean, restart: boolean, fadeS: number) {
    if (a.id.startsWith(LAYER_PREFIX) || a.id === COMMERCIALS_CHANNEL) return // a video file plays with its picture
    void this.devices.get(device)?.then((d) => {
      const el = d?.el
      if (!el) return
      clearTimeout((el as HTMLAudioElement & { pauseTimer?: number }).pauseTimer)
      if (on) {
        if (restart) el.currentTime = 0
        el.play().then(
          () => this.problems.delete(a.id),
          () => this.problems.set(a.id, 'Click the page once to let sound play')
        )
      } else {
        ;(el as HTMLAudioElement & { pauseTimer?: number }).pauseTimer = window.setTimeout(() => el.pause(), fadeS * 1000 + 300)
      }
    })
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
    if (a.kind === 'file') return a.url ? `file:${a.id}:${a.url}` : undefined
    if (a.kind === 'video') {
      // A network camera's sound comes with its picture, from the app (see netcams).
      if (a.device?.startsWith('net:')) return NET_SOUND + a.device
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
      if (id.startsWith('file:')) return this.openFile(id)
      if (id.startsWith(NET_SOUND)) {
        // Filled as the camera's sound arrives (pushNetSound).
        const node = this.ctx.createGain()
        node.channelCount = 2
        node.channelCountMode = 'explicit'
        const splitter = this.ctx.createChannelSplitter(2)
        node.connect(splitter)
        this.netSound.set(id.slice(NET_SOUND.length), { node, next: 0 })
        return { node, splitter, channels: 2 }
      }
      if (id.startsWith(TONE_DEVICE)) {
        // A sine tone, made here (one per channel that uses it).
        const osc = this.ctx.createOscillator()
        osc.frequency.value = Number(id.slice(TONE_DEVICE.length)) || TONE_HZ
        osc.start()
        const splitter = this.ctx.createChannelSplitter(1)
        osc.connect(splitter)
        return { node: osc, splitter, channels: 1 }
      }
      if (id === 'desktop') {
        if (!this.desktop) return null
        stream = this.desktop
      } else if (id.startsWith(`${GFX_DEVICE}video:`)) {
        const n = Number(id.slice(`${GFX_DEVICE}video:`.length))
        const el = this.state?.scenes
          .flatMap((x) => x.layers)
          .map((l) => (l.kind === 'graphics' ? this.graphicsVideo(l) : null))
          .find((v) => v?.n === n)?.el
        if (!el) return null
        let node = this.mediaNodes.get(el)
        if (!node) {
          node = this.ctx.createMediaElementSource(el)
          this.mediaNodes.set(el, node)
        }
        // Now its sound goes only through the mixer (not straight to the speakers).
        el.muted = false
        const splitter = this.ctx.createChannelSplitter(2)
        const up = this.stereo(node)
        up.connect(splitter)
        return { node: up, splitter, channels: 2 }
      } else if (id.startsWith(GFX_DEVICE)) {
        const want = id.slice(GFX_DEVICE.length)
        const st = this.state?.scenes
          .flatMap((x) => x.layers)
          .map((l) => (l.kind === 'graphics' ? this.graphicsStream(l) : null))
          .find((x) => x?.id === want)
        if (!st?.getAudioTracks().length) return null
        stream = st
        if (!this.pullers.has(want)) {
          const el = new Audio()
          el.muted = true
          el.srcObject = st
          void el.play().catch(() => {})
          this.pullers.set(want, el)
        }
      } else if (id.startsWith(PHONE_PREFIX)) {
        const phone = this.phoneStream(id)
        if (!phone?.getAudioTracks().length) return null
        stream = new MediaStream(phone.getAudioTracks())
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

  /** A music file (an audio element), or the sound of a video file in a scene (its video element). */
  private async openFile(id: string): Promise<DeviceInput | null> {
    const rest = id.slice('file:'.length)
    const sourceId = rest.slice(0, rest.indexOf(':'))
    const url = rest.slice(rest.indexOf(':') + 1)
    let el: HTMLMediaElement | null
    if (sourceId.startsWith(LAYER_PREFIX) || sourceId === COMMERCIALS_CHANNEL) {
      el = this.mediaElement(url)
      if (!el) return null
      el.muted = false
    } else {
      const audio = new Audio()
      audio.preload = 'auto'
      audio.src = fileUrl(url)
      el = audio
    }
    let node = this.mediaNodes.get(el)
    if (!node) {
      node = this.ctx.createMediaElementSource(el)
      this.mediaNodes.set(el, node)
    }
    const splitter = this.ctx.createChannelSplitter(2)
    const up = this.stereo(node)
    up.connect(splitter)
    return { el: el instanceof HTMLAudioElement ? el : undefined, node: up, splitter, channels: 2 }
  }

  /**
   * A video's sound as left and right. A mono video would otherwise play on the
   * left only: a channel splitter does not spread one channel to both sides.
   */
  private stereo(node: AudioNode) {
    const up = this.ctx.createGain()
    up.channelCount = 2
    up.channelCountMode = 'explicit'
    up.channelInterpretation = 'speakers'
    node.connect(up)
    return up
  }

  private build(a: AudioSource, key: string, device: string | undefined): Chain {
    const merger = this.ctx.createChannelMerger(2)
    const delay = this.ctx.createDelay(5)
    const gain = this.ctx.createGain()
    const gate = this.ctx.createGain()
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 1024
    merger.connect(delay).connect(gain).connect(analyser)
    gain.connect(gate).connect(this.bus)
    const chain: Chain = { key, merger, delay, gain, gate, open: false, analyser, buf: new Float32Array(analyser.fftSize) }
    this.chains.set(a.id, chain)
    this.problems.delete(a.id)
    if (!device) {
      this.problems.set(a.id, a.kind === 'video' ? 'No sound found for this video input' : a.kind === 'file' ? 'Pick a file' : 'Pick a device')
      return chain
    }
    this.attach(a, chain, device, 0)
    return chain
  }

  /** Open the channel's device and wire it in. A video's sound that isn't ready yet is tried again. */
  private attach(a: AudioSource, chain: Chain, device: string, tries: number) {
    void this.openDevice(device).then((d) => {
      if (this.chains.get(a.id) !== chain) return
      const merger = chain.merger
      if (!d && device.startsWith('file:') && tries < RETRIES) {
        // Don't keep the failure: the next try opens it afresh (the video may not be loaded yet).
        this.devices.delete(device)
        const what = (a.url ?? '').split(/[\\/]/).pop()
        this.problems.set(a.id, `No sound yet from “${what}” · trying again…`)
        window.setTimeout(() => this.chains.get(a.id) === chain && this.attach(a, chain, device, tries + 1), 1000)
        return
      }
      this.problems.delete(a.id)
      if (!d) {
        this.problems.set(
          a.id,
          device === 'desktop'
            ? 'Needs a click to share desktop sound'
            : device.startsWith(PHONE_PREFIX)
              ? 'Phone not connected'
              : device.startsWith('file:')
                ? `Could not play “${(a.url ?? '').split(/[\\/]/).pop()}”`
                : 'Could not open the device'
        )
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
  }

  private drop(id: string) {
    const c = this.chains.get(id)
    if (!c) return
    c.unlink?.()
    c.merger.disconnect()
    c.gain.disconnect()
    c.gate.disconnect()
    this.chains.delete(id)
    this.problems.delete(id)
  }

  close() {
    this.monitorEl?.pause()
    for (const [id, p] of this.devices) void p.then((d) => stopTracks(id, d))
    void this.ctx.close()
  }
}
