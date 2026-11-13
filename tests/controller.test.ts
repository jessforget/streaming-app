import { describe, expect, it, beforeEach } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimAtem, SimEngine } from '../src/core/sim'
import { CommandError } from '../src/shared/protocol'

function setup() {
  const engine = new SimEngine()
  const atem = new SimAtem()
  atem.autoMs = 5
  const keys = new MemoryKeyStore()
  const c = new Controller({ engine, atem, keys, initial: defaultState(), now: () => 1000 })
  return { engine, atem, keys, c }
}

describe('scenes', () => {
  let t: ReturnType<typeof setup>
  beforeEach(async () => {
    t = setup()
    await t.c.start({ statsIntervalMs: 0 })
  })

  it('queues a scene in preview and takes it live, swapping like a vision mixer', async () => {
    await t.c.run('local', 'scene.preview', { sceneId: 'live' })
    expect(t.c.state.previewSceneId).toBe('live')
    await t.c.run('local', 'scene.goLive')
    expect(t.c.state.programSceneId).toBe('live')
    expect(t.c.state.previewSceneId).toBe('starting')
    expect(t.engine.program).toBe('live')
  })

  it('rejects unknown scenes and bad params with plain words', async () => {
    await expect(t.c.run('local', 'scene.preview', { sceneId: 'nope' })).rejects.toThrow('No scene with id nope')
    await expect(t.c.run('local', 'audio.setVolume', { sourceId: 'mic', volume: 3 })).rejects.toThrow(
      'volume must be a number from 0 to 1'
    )
    await expect(t.c.run('local', 'not.a.command')).rejects.toBeInstanceOf(CommandError)
  })

  it('mutes everything with one command', async () => {
    await t.c.run('buttons', 'audio.muteAll')
    expect(t.c.state.audio.every((a) => a.muted)).toBe(true)
  })
})

describe('roles', () => {
  it('lets each role do only its own job', async () => {
    const { c } = setup()
    await c.start({ statsIntervalMs: 0 })
    await expect(c.run('data', 'scene.goLive')).rejects.toThrow('Not allowed')
    await expect(c.run('viewer', 'audio.muteAll')).rejects.toThrow('Not allowed')
    await expect(c.run('remote', 'settings.setQuality', { quality: 'low' })).rejects.toThrow('Not allowed')
    await expect(c.run('buttons', 'data.set', { values: { a: 1 } })).rejects.toThrow('Not allowed')
    await c.run('data', 'data.set', { values: { a: 1 } })
    await c.run('viewer', 'state.get')
  })
})

describe('data fields', () => {
  it('stores values with who sent them and updates text layers that use them', async () => {
    const { c, engine } = setup()
    await c.start({ statsIntervalMs: 0 })
    await c.run('data', 'data.set', { values: { 'guest.name': 'Sam', 'team1.score': 3 } }, 'Scoreboard PC')
    expect(c.state.data['guest.name']).toEqual({ value: 'Sam', updatedAt: 1000, source: 'Scoreboard PC' })
    expect(engine.texts.get('live/live-lower-third')).toBe('Sam')
    expect(engine.texts.get('live/live-score')).toBe(' 3 -  ')
  })

  it('refuses bad field names and values', async () => {
    const { c } = setup()
    await c.start({ statsIntervalMs: 0 })
    await expect(c.run('data', 'data.set', { values: { 'bad name': 1 } })).rejects.toThrow('Bad field name')
    await expect(c.run('data', 'data.set', { values: { a: { nested: true } } })).rejects.toThrow('must be text')
    await expect(c.run('data', 'data.set', { values: 'x' })).rejects.toThrow('values must be an object')
  })

  it('clears some or all fields', async () => {
    const { c } = setup()
    await c.start({ statsIntervalMs: 0 })
    await c.run('data', 'data.set', { values: { a: 1, b: 2 } })
    await c.run('data', 'data.clear', { keys: ['a'] })
    expect(Object.keys(c.state.data)).toEqual(['b'])
    await c.run('data', 'data.clear', {})
    expect(c.state.data).toEqual({})
  })
})

describe('streaming', () => {
  it('needs a stream key before going live, and never puts the key in state', async () => {
    const { c, engine } = setup()
    await c.start({ statsIntervalMs: 0 })
    await expect(c.run('local', 'stream.start')).rejects.toThrow('Add your YouTube stream key')
    await c.run('local', 'settings.setDestination', { id: 'youtube', streamKey: 'secret-key' })
    expect(JSON.stringify(c.state)).not.toContain('secret-key')
    expect(c.state.stream.destinations.find((d) => d.id === 'youtube')?.hasKey).toBe(true)
    await c.run('remote', 'stream.start')
    expect(c.state.stream.live).toBe(true)
    expect(engine.streaming).toEqual([
      {
        destinationId: 'youtube',
        platform: 'youtube',
        url: 'rtmps://a.rtmps.youtube.com:443/live2',
        key: 'secret-key',
        vertical: false
      }
    ])
    await c.run('remote', 'stream.stop')
    expect(c.state.stream.live).toBe(false)
  })

  it('streams to up to 3 platforms at once, Instagram vertical with its own address', async () => {
    const { c, engine } = setup()
    await c.start({ statsIntervalMs: 0 })
    await c.run('local', 'settings.setDestination', { id: 'youtube', streamKey: 'yt' })
    await c.run('local', 'settings.setDestination', { id: 'facebook', enabled: true, streamKey: 'fb' })
    await c.run('local', 'settings.setDestination', { id: 'instagram', enabled: true, streamKey: 'ig' })
    await expect(c.run('local', 'settings.setDestination', { id: 'twitch', enabled: true })).rejects.toThrow(
      'at most 3 platforms'
    )
    await expect(c.run('local', 'stream.start')).rejects.toThrow('Add the Instagram server address')
    await expect(
      c.run('local', 'settings.setDestination', { id: 'instagram', serverUrl: 'http://nope' })
    ).rejects.toThrow('must start with rtmp')
    await c.run('local', 'settings.setDestination', { id: 'instagram', serverUrl: 'rtmps://example.test:443/rtmp/' })
    await c.run('local', 'stream.start')
    expect(engine.streaming.map((t) => [t.platform, t.vertical])).toEqual([
      ['youtube', false],
      ['facebook', false],
      ['instagram', true]
    ])
    c.tickStats()
    expect(c.state.stats.requiredKbps).toBe(3 * (4500 + 160))
  })

  it('turns dropped frames into plain words', async () => {
    const { c, engine } = setup()
    await c.start({ statsIntervalMs: 0 })
    await c.run('local', 'settings.setDestination', { id: 'youtube', streamKey: 'yt' })
    await c.run('local', 'stream.start')
    c.tickStats()
    expect(c.state.stats.health).toBe('good')
    engine.dropRate = 0.2
    c.tickStats()
    expect(c.state.stats.health).toBe('bad')
    expect(c.state.stats.message).toContain("upload can't keep up")
  })

  it('records and stops', async () => {
    const { c, engine } = setup()
    await c.start({ statsIntervalMs: 0 })
    await c.run('buttons', 'record.start')
    expect(engine.recording).toBe(true)
    expect(c.state.recording.startedAt).toBe(1000)
    await c.run('buttons', 'record.stop')
    expect(engine.recording).toBe(false)
  })
})

describe('ATEM', () => {
  it('says plainly when the ATEM is not connected', async () => {
    const { c } = setup()
    await c.start({ statsIntervalMs: 0 })
    await expect(c.run('remote', 'atem.cut')).rejects.toThrow('The ATEM is not connected')
  })

  it('switches cameras, and mirrors the ATEM state', async () => {
    const { c } = setup()
    await c.start({ statsIntervalMs: 0 })
    await c.run('local', 'settings.setAtemHost', { host: '192.168.1.240' })
    await new Promise((r) => setTimeout(r, 0))
    expect(c.state.atem).toMatchObject({ connected: true, host: '192.168.1.240', program: 1, preview: 2 })
    await c.run('remote', 'atem.preview', { input: 3 })
    await c.run('remote', 'atem.cut')
    expect(c.state.atem).toMatchObject({ program: 3, preview: 1 })
    await expect(c.run('remote', 'atem.program', { input: 9 })).rejects.toThrow('no input 9')
    await c.run('remote', 'atem.auto')
    expect(c.state.atem.inTransition).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(c.state.atem).toMatchObject({ program: 1, preview: 3, inTransition: false })
  })

  it('can put a camera on air when a scene goes live', async () => {
    const { c } = setup()
    c.state.scenes[1].atemInput = 4
    await c.start({ statsIntervalMs: 0 })
    await c.run('local', 'settings.setAtemHost', { host: 'atem.local' })
    await new Promise((r) => setTimeout(r, 0))
    await c.run('local', 'scene.program', { sceneId: 'live' })
    expect(c.state.atem.program).toBe(4)
  })
})
