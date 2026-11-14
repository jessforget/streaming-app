import { describe, expect, it, beforeEach } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { CommandError } from '../src/shared/protocol'
import { audioDeviceName } from '../src/shared/state'

function setup() {
  const engine = new SimEngine()
  const keys = new MemoryKeyStore()
  const c = new Controller({ engine, keys, initial: defaultState(), now: () => 1000 })
  return { engine, keys, c }
}

describe('scenes', () => {
  let t: ReturnType<typeof setup>
  beforeEach(async () => {
    t = setup()
    await t.c.start({ statsIntervalMs: 0, devicePollMs: 0 })
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
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
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
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
    await c.run('data', 'data.set', { values: { 'guest.name': 'Sam', 'team1.score': 3 } }, 'Scoreboard PC')
    expect(c.state.data['guest.name']).toEqual({ value: 'Sam', updatedAt: 1000, source: 'Scoreboard PC' })
    expect(engine.texts.get('live/live-lower-third')).toBe('Sam')
    expect(engine.texts.get('live/live-score')).toBe(' 3 -  ')
  })

  it('refuses bad field names and values', async () => {
    const { c } = setup()
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
    await expect(c.run('data', 'data.set', { values: { 'bad name': 1 } })).rejects.toThrow('Bad field name')
    await expect(c.run('data', 'data.set', { values: { a: { nested: true } } })).rejects.toThrow('must be text')
    await expect(c.run('data', 'data.set', { values: 'x' })).rejects.toThrow('values must be an object')
  })

  it('clears some or all fields', async () => {
    const { c } = setup()
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
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
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
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
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
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
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
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
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
    await c.run('buttons', 'record.start')
    expect(engine.recording).toBe(true)
    expect(c.state.recording.startedAt).toBe(1000)
    await c.run('buttons', 'record.stop')
    expect(engine.recording).toBe(false)
  })
})

describe('video and audio inputs (no camera switching, like OBS)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(async () => {
    t = setup()
    await t.c.start({ statsIntervalMs: 0, devicePollMs: 0 })
  })

  it('lists the capture and audio devices the PC can see', () => {
    expect(t.c.state.inputs.video.map((d) => d.id)).toEqual(['atem-mini', 'decklink-1', 'usb-capture'])
    expect(t.c.state.inputs.audio.map((d) => d.id)).toContain('atem-mini-audio')
  })

  it('has no camera switching commands', async () => {
    await expect(t.c.run('local', 'atem.cut' as never)).rejects.toBeInstanceOf(CommandError)
  })

  it('adds an ATEM or HyperDeck as a video source, on top, with a name from the device', async () => {
    const r = (await t.c.run('local', 'layer.add', { sceneId: 'brb', kind: 'video', device: 'decklink-1' })) as { layerId: string }
    const brb = t.c.state.scenes.find((s) => s.id === 'brb')!
    expect(brb.layers[0]).toMatchObject({ id: r.layerId, kind: 'video', device: 'decklink-1', name: 'DeckLink Mini Recorder' })
    expect(t.engine.scenes.get('brb')!.layers[0].id).toBe(r.layerId)
    await expect(t.c.run('local', 'layer.add', { sceneId: 'brb', kind: 'video', device: 'nope' })).rejects.toThrow()
    await expect(t.c.run('local', 'layer.add', { sceneId: 'brb', kind: 'atem' as never })).rejects.toThrow('kind must be')
  })

  it('can put a camera behind the graphics, and the same camera in several scenes', async () => {
    const dev = t.c.state.inputs.video[0].id
    for (const sceneId of ['live', 'ending']) await t.c.run('local', 'layer.add', { sceneId, kind: 'video', device: dev, at: 'bottom' })
    for (const sceneId of ['live', 'ending']) expect(t.c.state.scenes.find((s) => s.id === sceneId)!.layers.at(-1)).toMatchObject({ kind: 'video', device: dev })
    await expect(t.c.run('local', 'layer.add', { sceneId: 'live', kind: 'video', device: dev, at: 'middle' as never })).rejects.toThrow('top or bottom')
  })

  it('edits, reorders and removes sources', async () => {
    const r = (await t.c.run('local', 'layer.add', { sceneId: 'brb', kind: 'text', text: '{guest.name}' })) as { layerId: string }
    await t.c.run('local', 'layer.update', { sceneId: 'brb', layerId: r.layerId, name: 'Guest', text: 'Hello' })
    const brb = () => t.c.state.scenes.find((s) => s.id === 'brb')!
    expect(brb().layers[0]).toMatchObject({ name: 'Guest', text: 'Hello' })
    await t.c.run('local', 'layer.move', { sceneId: 'brb', layerId: r.layerId, direction: 'down' })
    expect(brb().layers[1].id).toBe(r.layerId)
    await t.c.run('local', 'layer.remove', { sceneId: 'brb', layerId: r.layerId })
    expect(brb().layers.find((l) => l.id === r.layerId)).toBeUndefined()
    await expect(
      t.c.run('local', 'layer.update', { sceneId: 'brb', layerId: 'brb-title', device: 'atem-mini' })
    ).rejects.toThrow('Only video sources')
  })

  it('adds, renames and removes scenes, but never the one on air', async () => {
    const r = (await t.c.run('local', 'scene.add', { name: 'Interview' })) as { sceneId: string }
    await t.c.run('local', 'scene.rename', { sceneId: r.sceneId, name: 'Two-shot' })
    expect(t.c.state.scenes.at(-1)).toMatchObject({ id: r.sceneId, name: 'Two-shot', layers: [] })
    await expect(t.c.run('local', 'scene.remove', { sceneId: t.c.state.programSceneId })).rejects.toThrow('on air')
    await t.c.run('local', 'scene.remove', { sceneId: r.sceneId })
    expect(t.c.state.scenes.find((s) => s.id === r.sceneId)).toBeUndefined()
    await expect(t.c.run('local', 'scene.add', { name: '' })).rejects.toThrow()
  })

  it('adds and removes audio channels, including a capture card’s sound', async () => {
    const r = (await t.c.run('local', 'audio.add', { name: 'Capture', kind: 'video', device: 'usb-capture' })) as { sourceId: string }
    expect(t.c.state.audio.at(-1)).toMatchObject({ id: r.sourceId, kind: 'video', device: 'usb-capture' })
    await expect(t.c.run('local', 'audio.add', { name: 'X', kind: 'device', device: 'atem-mini' })).rejects.toThrow()
    await t.c.run('local', 'audio.remove', { sourceId: r.sourceId })
    expect(t.c.state.audio.find((a) => a.id === r.sourceId)).toBeUndefined()
  })

  it('only lets admin callers change the setup', async () => {
    await expect(t.c.run('remote', 'scene.add', { name: 'Nope' })).rejects.toBeInstanceOf(CommandError)
    await expect(t.c.run('remote', 'layer.remove', { sceneId: 'brb', layerId: 'brb-title' })).rejects.toBeInstanceOf(CommandError)
    await t.c.run('remote', 'layer.setVisible', { sceneId: 'brb', layerId: 'brb-title', visible: false })
  })
})

describe('USB audio interfaces (Zoom L-12, Focusrite)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(async () => {
    t = setup()
    await t.c.start({ statsIntervalMs: 0, devicePollMs: 0 })
  })

  it('shows Windows audio devices by the device name first', () => {
    expect(audioDeviceName('Microphone (2- ZOOM L-12 Audio)')).toBe('ZOOM L-12 Audio · Microphone')
    expect(audioDeviceName('Analogue 1 + 2 (Focusrite USB Audio)')).toBe('Focusrite USB Audio · Analogue 1 + 2')
    expect(audioDeviceName('Focusrite USB ASIO')).toBe('Focusrite USB ASIO')
  })

  it('lists multichannel interfaces with their channel names', () => {
    const l12 = t.c.state.inputs.audio.find((d) => d.id === 'zoom-l12')!
    expect(l12).toMatchObject({ driver: 'asio', channels: 14 })
    expect(l12.channelNames?.[0]).toBe('Ch 1')
  })

  it('gives each mic input its own mixer channel, with a sync offset', async () => {
    const r = (await t.c.run('local', 'audio.add', {
      name: 'Host',
      kind: 'device',
      device: 'zoom-l12',
      channels: [3],
      syncOffsetMs: 80
    })) as { sourceId: string }
    expect(t.c.state.audio.at(-1)).toMatchObject({ id: r.sourceId, device: 'zoom-l12', channels: [3], syncOffsetMs: 80 })
    await t.c.run('local', 'audio.add', { name: 'Pair', kind: 'device', device: 'zoom-l12', channels: [9, 10] })
    expect(t.c.state.audio.at(-1)).toMatchObject({ channels: [9, 10], syncOffsetMs: 0 })
  })

  it('refuses channels the device does not have', async () => {
    const add = (channels: unknown) => t.c.run('local', 'audio.add', { name: 'X', kind: 'device', device: 'zoom-l12', channels } as never)
    await expect(add([15])).rejects.toThrow('from 1 to 14')
    await expect(add([1, 1])).rejects.toThrow()
    await expect(add([1, 2, 3])).rejects.toThrow()
    await expect(t.c.run('local', 'audio.add', { name: 'X', kind: 'device', device: 'usb-mic', channels: [3] })).rejects.toThrow('from 1 to 2')
    await expect(t.c.run('local', 'audio.add', { name: 'X', kind: 'device', device: 'usb-mic', syncOffsetMs: 99999 })).rejects.toThrow()
  })

  it('edits a channel: name, inputs and sync offset', async () => {
    await t.c.run('local', 'audio.update', { sourceId: 'mic', name: 'Host mic', syncOffsetMs: 40 })
    expect(t.c.state.audio.find((a) => a.id === 'mic')).toMatchObject({ name: 'Host mic', syncOffsetMs: 40 })
    // Sound can only be held back, not played early.
    await expect(t.c.run('local', 'audio.update', { sourceId: 'mic', syncOffsetMs: -40 })).rejects.toThrow('from 0')
    await expect(t.c.run('local', 'audio.update', { sourceId: 'desktop', channels: [1] })).rejects.toThrow('Desktop')
    // Move the mic to the L-12: its channels start again from the first pair.
    await t.c.run('local', 'audio.update', { sourceId: 'mic', device: 'zoom-l12' })
    expect(t.c.state.audio.find((a) => a.id === 'mic')).toMatchObject({ device: 'zoom-l12', channels: undefined })
    await expect(t.c.run('local', 'audio.update', { sourceId: 'mic', device: 'nope' })).rejects.toThrow('no audio device')
    await expect(t.c.run('remote', 'audio.update', { sourceId: 'mic', syncOffsetMs: 0 })).rejects.toBeInstanceOf(CommandError)
  })

  it('follows a device whose id changed, by its name', async () => {
    await t.c.run('local', 'audio.add', { name: 'Host', kind: 'device', device: 'zoom-l12', channels: [1] })
    const notices: string[] = []
    t.c.on('error', (m) => notices.push(m))
    const l12 = t.engine.devices.audio.find((d) => d.id === 'zoom-l12')!
    t.engine.devices.audio = t.engine.devices.audio.map((d) => (d === l12 ? { ...l12, id: 'zoom-l12-new-id' } : d))
    await t.c.pollDevices()
    expect(t.c.state.audio.find((a) => a.name === 'Host')?.device).toBe('zoom-l12-new-id')
    expect(notices).toEqual([])
  })

  it('notices a device in use being unplugged and plugged back in', async () => {
    await t.c.run('local', 'audio.add', { name: 'Host', kind: 'device', device: 'zoom-l12', channels: [1] })
    const notices: string[] = []
    t.c.on('error', (m) => notices.push(m))
    const l12 = t.engine.devices.audio.find((d) => d.id === 'zoom-l12')!
    t.engine.devices.audio = t.engine.devices.audio.filter((d) => d !== l12)
    await t.c.pollDevices()
    expect(notices).toEqual(['ZOOM L-12 (ASIO) was unplugged'])
    expect(t.c.state.inputs.audio.some((d) => d.id === 'zoom-l12')).toBe(false)
    t.engine.devices.audio.push(l12)
    await t.c.pollDevices()
    expect(t.c.state.inputs.audio.some((d) => d.id === 'zoom-l12')).toBe(true)
    expect(notices).toHaveLength(1)
  })
})
