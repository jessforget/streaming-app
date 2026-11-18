import { beforeEach, describe, expect, it } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'

describe('Commercial break sound', () => {
  let c: Controller
  beforeEach(async () => {
    c = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: defaultState(), now: () => 1000 })
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
  })

  it('needs a break first, then keeps its level, mute and mics setting', async () => {
    await expect(c.run('local', 'cue.sound', { volume: 0.5 })).rejects.toThrow(/No commercial break/)
    await c.run('local', 'cue.commercial', { items: [{ name: 'Ad', path: '/tmp/ad.mp4' }] })
    const scene = () => c.state.scenes.find((s) => s.commercial)!
    expect(scene().breakSound).toBeUndefined()
    await c.run('local', 'cue.sound', { volume: 0.5 })
    expect(scene().breakSound).toEqual({ volume: 0.5, muted: false, mics: 'off' })
    await c.run('local', 'cue.sound', { muted: true, mics: 'duck' })
    expect(scene().breakSound).toEqual({ volume: 0.5, muted: true, mics: 'duck' })
    await c.run('local', 'cue.sound', { volume: 9 })
    expect(scene().breakSound?.volume).toBe(2)
    await expect(c.run('local', 'cue.sound', { mics: 'loud' })).rejects.toThrow(/mics/)
    // Emptying the break keeps its sound settings for the next one.
    await c.run('local', 'cue.clear', {})
    expect(scene().layers).toEqual([])
    expect(scene().breakSound?.mics).toBe('duck')
  })
})
