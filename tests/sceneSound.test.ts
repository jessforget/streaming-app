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
    // The HyperDeck's sound plays only where the HyperDeck is (Playback), not in every scene.
    expect(heard('live')).toEqual(['atem-audio', 'mic', 'desktop'])
    expect(heard('playback')).toContain('hyperdeck-audio')
    await c.run('local', 'scene.setSound', { sceneId: 'live', sourceId: 'atem-audio' })
    expect(heard('live')).toEqual(['atem-audio'])
    expect(heard('brb')).toEqual(['atem-audio', 'mic', 'desktop'])
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

  it('a camera scene plays only its own camera, even when other cameras were set to every scene', async () => {
    await c.run('local', 'inputs.report', {
      video: [
        { id: 'net:atem', name: 'atem (network)' },
        { id: 'phone:1', name: 'ALT-LX2 (phone)' },
        { id: 'phone:2', name: 'iPhone (phone)' }
      ],
      audio: []
    })
    // Old setups: every phone's sound was set to play in every scene.
    for (const [device, name] of [['phone:1', 'ALT-LX2'], ['phone:2', 'iPhone']]) await c.run('local', 'audio.add', { kind: 'video', device, name: `${name} sound` })
    await c.run('local', 'scene.add', { name: 'ATEM' })
    const atem = c.state.scenes.find((s) => s.name === 'ATEM')!
    await c.run('local', 'layer.add', { sceneId: atem.id, kind: 'video', device: 'net:atem' })
    const atemSound = c.state.audio.find((a) => a.device === 'net:atem')!
    // Adding the camera brings its sound and takes the other cameras' sound out of this scene.
    expect(heard(atem.id)).toContain(atemSound.id)
    expect(heard(atem.id).filter((id) => c.state.audio.find((a) => a.id === id)!.kind === 'video')).toEqual([atemSound.id])
    // A phone scene: only that phone.
    await c.run('local', 'scene.add', { name: 'HONOR' })
    const honor = c.state.scenes.find((s) => s.name === 'HONOR')!
    await c.run('local', 'layer.add', { sceneId: honor.id, kind: 'video', device: 'phone:1' })
    const videoHeard = (id: string) => heard(id).filter((x) => c.state.audio.find((a) => a.id === x)!.kind === 'video')
    expect(videoHeard(honor.id)).toEqual([c.state.audio.find((a) => a.device === 'phone:1')!.id])
    expect(videoHeard(atem.id)).toEqual([atemSound.id])
    // Mics and music stay as they were.
    expect(heard(atem.id)).toContain('mic')
  })

  it('opening an old setup: a camera sound set to every scene plays only where that camera is', async () => {
    const init = defaultState()
    init.inputs.video.push({ id: 'phone:1', name: 'ALT-LX2 (phone)' })
    init.audio.push({ id: 'phone-sound', name: 'ALT-LX2 (phone) sound', kind: 'video', device: 'phone:1', syncOffsetMs: 0, volume: 0.8, muted: false, level: 0 })
    init.scenes.push({ id: 'honor', name: 'HONOR', layers: [{ id: 'cam', name: 'ALT-LX2', kind: 'video', visible: true, device: 'phone:1' }] })
    const d = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: init, now: () => 1000 })
    expect(d.state.audio.find((a) => a.id === 'phone-sound')!.scenes).toEqual(['honor'])
    expect(d.state.audio.find((a) => a.id === 'hyperdeck-audio')!.scenes).toEqual(['playback'])
  })
})
