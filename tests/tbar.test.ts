import { beforeEach, describe, expect, it } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'

describe('Manual fader (T-bar) and fade time', () => {
  let c: Controller
  beforeEach(async () => {
    c = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: defaultState(), now: () => 1000 })
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
    await c.run('local', 'scene.program', { sceneId: 'starting' })
    await c.run('local', 'scene.preview', { sceneId: 'live' })
  })

  it('mixes by hand, and at the end puts Preview on air', async () => {
    await c.run('local', 'transition.mix', { level: 0.4 })
    expect(c.state.mix).toBe(0.4)
    expect(c.state.programSceneId).toBe('starting')
    await c.run('local', 'transition.mix', { level: 1 })
    expect(c.state.mix).toBeUndefined()
    expect(c.state.programSceneId).toBe('live')
    expect(c.state.previewSceneId).toBe('starting')
    // The chosen transition is kept.
    expect(c.state.transition.kind).toBe('fade')
  })

  it('a half mix ends when Preview changes or a scene is taken another way', async () => {
    await c.run('local', 'transition.mix', { level: 0.5 })
    await c.run('local', 'scene.preview', { sceneId: 'brb' })
    expect(c.state.mix).toBeUndefined()
    await c.run('local', 'transition.mix', { level: 0.5 })
    await c.run('local', 'scene.goLive', {})
    expect(c.state.mix).toBeUndefined()
    expect(c.state.programSceneId).toBe('brb')
  })

  it('sets the fade time, up to 5 seconds', async () => {
    await c.run('local', 'transition.set', { kind: 'fade', durationMs: 1000 })
    expect(c.state.transition).toEqual({ kind: 'fade', durationMs: 1000 })
    await expect(c.run('local', 'transition.set', { kind: 'fade', durationMs: 9000 })).rejects.toThrow()
    await expect(c.run('local', 'transition.mix', { level: 2 })).rejects.toThrow()
  })
})
