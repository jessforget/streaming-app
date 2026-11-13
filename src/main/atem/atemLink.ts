/**
 * Real ATEM link over the network, using atem-connection (an open-source
 * Node.js implementation of Blackmagic's ATEM protocol, UDP port 9910).
 * Video does not travel this way: on an ATEM Mini the program output reaches
 * the PC over USB-C as a webcam, picked up by the engine.
 */
import { Atem, AtemConnectionStatus, Enums } from 'atem-connection'
import type { AtemLink, AtemSnapshot } from '../../core/ports'

const ME = 0

export class NetworkAtemLink implements AtemLink {
  private atem: Atem | null = null
  private listeners: ((s: AtemSnapshot) => void)[] = []

  async connect(host: string) {
    await this.disconnect()
    const atem = new Atem()
    this.atem = atem
    atem.on('connected', () => this.publish())
    atem.on('disconnected', () => this.publish())
    atem.on('stateChanged', () => this.publish())
    atem.on('error', () => {})
    await atem.connect(host)
  }

  async disconnect() {
    const atem = this.atem
    this.atem = null
    if (atem) {
      await atem.disconnect().catch(() => {})
      await atem.destroy().catch(() => {})
    }
    this.publish()
  }

  async setPreview(input: number) {
    await this.need().changePreviewInput(input, ME)
  }
  async setProgram(input: number) {
    await this.need().changeProgramInput(input, ME)
  }
  async cut() {
    await this.need().cut(ME)
  }
  async auto() {
    await this.need().autoTransition(ME)
  }

  onChange(fn: (s: AtemSnapshot) => void) {
    this.listeners.push(fn)
  }

  private need(): Atem {
    if (!this.atem || this.atem.status !== AtemConnectionStatus.CONNECTED) throw new Error('The ATEM is not connected')
    return this.atem
  }

  private snapshot(): AtemSnapshot {
    const atem = this.atem
    const state = atem?.state
    if (!atem || !state || atem.status !== AtemConnectionStatus.CONNECTED) {
      return { connected: false, model: '', inputs: [], program: null, preview: null, inTransition: false }
    }
    const me = state.video.mixEffects[ME]
    const inputs = Object.values(state.inputs)
      .filter((i) => i && i.internalPortType === Enums.InternalPortType.External)
      .map((i) => ({ id: i!.inputId, shortName: i!.shortName, longName: i!.longName }))
      .sort((a, b) => a.id - b.id)
    return {
      connected: true,
      model: state.info.productIdentifier ?? 'ATEM',
      inputs,
      program: me?.programInput ?? null,
      preview: me?.previewInput ?? null,
      inTransition: me?.transitionPosition.inTransition ?? false
    }
  }

  private publish() {
    const s = this.snapshot()
    this.listeners.forEach((fn) => fn(s))
  }
}
