import { describe, expect, it } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { cameraRate, familyOf, presetFor } from '../src/shared/presets'
import { measureFps } from '../src/renderer/src/studio/netcams'

const every = (ms: number, n: number) => Array.from({ length: n }, (_, i) => i * ms)

describe('frame rate matching', () => {
  it('measures a camera from when its pictures arrive', () => {
    expect(measureFps(every(40, 75))).toBe(25)
    expect(measureFps(every(1000 / 29.97, 90))).toBe(29.97)
    expect(measureFps(every(20, 150))).toBe(50)
    expect(measureFps(every(40, 10))).toBe(0) // not enough yet
    // Wi-Fi jitter of a few ms either way still reads as 25.
    expect(measureFps(every(40, 75).map((t, i) => t + (i % 2 ? 9 : -9)))).toBe(25)
  })

  it('switches 30 to 25 and 60 to 50 for 25 fps cameras', () => {
    expect(presetFor('medium', 'pal').fps).toBe(25)
    expect(presetFor('high', 'pal').fps).toBe(50)
    expect(presetFor('medium', 'pal').summary).toBe('1080p, 25 fps')
    expect(presetFor('medium', 'ntsc').fps).toBe(30)
    expect(familyOf(25)).toBe('pal')
    expect(familyOf(59.94)).toBe('ntsc')
    expect(familyOf(24)).toBe(null)
  })

  it('goes by the cameras in the scenes', () => {
    const s = defaultState()
    s.scenes[0].layers.push({ id: 'z', name: 'Z', kind: 'video', visible: true, device: 'net:zcam' })
    s.inputs.video.push({ id: 'net:zcam', name: 'Z CAM E2 (network)' })
    const none = () => null
    expect(cameraRate(s, () => 25, none)).toEqual({ family: 'pal', note: 'Z CAM E2 25 fps' })
    // Not measured yet: nothing to go by.
    expect(cameraRate(s, () => 0, none).family).toBe(null)
    // A webcam that can do 30 doesn't decide; an ATEM stuck at 30 with a 25 camera does disagree only if fixed.
    expect(cameraRate(s, () => 25, () => ({ fps: 30, max: 30 })).family).toBe('pal')
    // An ATEM on 1080p25 (can't go above 25) and a 29.97 network camera: they differ.
    const differ = cameraRate(s, () => 29.97, () => ({ fps: 25, max: 25 }))
    expect(differ.family).toBe(null)
    expect(differ.note).toContain('Cameras differ')
  })

  it('streams at the cameras\' rate, but never changes it mid-stream', async () => {
    const engine = new SimEngine()
    const c = new Controller({ engine, keys: new MemoryKeyStore(), initial: defaultState(), now: () => 1000 })
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
    await c.run('local', 'settings.setDestination', { id: 'youtube', streamKey: 'k' })
    await c.run('local', 'studio.cameraRate', { family: 'pal', note: 'Z CAM E2 25 fps' })
    expect(c.state.stream.family).toBe('pal')
    await c.run('local', 'stream.start')
    expect((engine as unknown as { fps: number }).fps).toBe(25)
    // A 30 fps camera shows up while live: wait until the stream stops.
    await c.run('local', 'studio.cameraRate', { family: 'ntsc', note: 'Cam 30 fps' })
    expect(c.state.stream.family).toBe('pal')
    await expect(c.run('local', 'settings.setFrameRate', { frameRate: 'ntsc' })).rejects.toThrow('Stop streaming')
    await c.run('local', 'stream.stop')
    expect(c.state.stream.family).toBe('ntsc')
    // A fixed choice wins over the cameras; cameras that differ keep the current one.
    await c.run('local', 'settings.setFrameRate', { frameRate: 'pal' })
    expect(c.state.stream.family).toBe('pal')
    await c.run('local', 'settings.setFrameRate', { frameRate: 'auto' })
    await c.run('local', 'studio.cameraRate', { family: null, note: 'Cameras differ' })
    expect(c.state.stream.family).toBe('ntsc')
    await expect(c.run('remote', 'settings.setFrameRate', { frameRate: 'pal' })).rejects.toThrow('Not allowed')
  })
})
