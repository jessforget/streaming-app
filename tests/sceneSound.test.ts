import { beforeEach, describe, expect, it } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { audible } from '../src/shared/state'

describe('Sound follows the scene', () => {
  let c: Controller
  beforeEach(async () => {
    c = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: defaultState(), now: () => 1000 })
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
  })
  const heard = (sceneId: string) => c.state.audio.filter((a) => audible(a, new Set([sceneId]))).map((a) => a.id)

  it('picks one sound for a scene; the other scenes keep theirs', async () => {
    expect(heard('live')).toEqual(['atem-audio', 'hyperdeck-audio', 'mic', 'desktop'])
    await c.run('local', 'scene.setSound', { sceneId: 'live', sourceId: 'atem-audio' })
    expect(heard('live')).toEqual(['atem-audio'])
    expect(heard('brb')).toEqual(['atem-audio', 'hyperdeck-audio', 'mic', 'desktop'])
    await c.run('local', 'scene.addSound', { sceneId: 'live', sourceId: 'mic' })
    expect(heard('live')).toEqual(['atem-audio', 'mic'])
    await c.run('local', 'scene.removeSound', { sceneId: 'live', sourceId: 'atem-audio' })
    expect(heard('live')).toEqual(['mic'])
    await c.run('local', 'scene.setSound', { sceneId: 'starting', sourceId: null })
    expect(heard('starting')).toEqual([])
  })

  it('with the picture: the camera sound, made the first time', async () => {
    // The HyperDeck already has its sound channel.
    await c.run('local', 'scene.setSound', { sceneId: 'playback', sourceId: 'picture' })
    expect(heard('playback')).toEqual(['hyperdeck-audio'])
    // A network camera: a new channel for its sound.
    await c.run('local', 'scene.add', { name: 'Z CAM' })
    const z = c.state.scenes.find((s) => s.name === 'Z CAM')!
    await c.run('local', 'inputs.report', { video: [{ id: 'net:abc', name: 'Z CAM E2' }], audio: [] })
    await c.run('local', 'layer.add', { sceneId: z.id, kind: 'video', device: 'net:abc' })
    const zs = c.state.audio.find((a) => a.device === 'net:abc')!
    expect(zs.kind).toBe('video')
    expect(heard(z.id)).toEqual([zs.id])
    await expect(c.run('local', 'scene.setSound', { sceneId: 'starting', sourceId: 'picture' })).rejects.toThrow(/no camera/)
  })
})
