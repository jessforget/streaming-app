import { describe, expect, it } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'

describe('Phone camera: front / back', () => {
  it('keeps what the phone reports and passes on an ask to flip', async () => {
    const c = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: defaultState(), now: () => 1000 })
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
    await c.run('local', 'inputs.report', { video: [{ id: 'phone:p1', name: 'Pixel (phone)', facing: 'environment' }], audio: [] })
    expect(c.state.inputs.video[0].facing).toBe('environment')
    await c.run('local', 'phone.facing', { device: 'phone:p1', facing: 'user' })
    expect(c.state.phoneFlips?.['phone:p1']).toEqual({ facing: 'user', seq: 1 })
    await c.run('local', 'phone.facing', { device: 'phone:p1', facing: 'user' })
    expect(c.state.phoneFlips?.['phone:p1']?.seq).toBe(2)
    await expect(c.run('local', 'phone.facing', { device: 'phone:gone', facing: 'user' })).rejects.toThrow(/not connected/)
    await expect(c.run('local', 'phone.facing', { device: 'phone:p1', facing: 'sideways' as never })).rejects.toThrow()
  })

  it('keeps the camera settings the phone allows and passes on changes', async () => {
    const c = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: defaultState(), now: () => 1000 })
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
    const camera = [
      { key: 'exposure', label: 'Exposure', type: 'mode', value: 'auto', options: ['auto', 'manual'] },
      { key: 'shutter', label: 'Shutter', type: 'range', value: 50, min: 10, max: 100, step: 5, scale: 'log', fmt: 'shutter', show: ['exposure', 'manual'] },
      { key: 'evil', label: 'x', type: 'range', value: 1, min: 0, max: 2 },
      { key: 'zoom', label: 'Zoom', type: 'range', value: 1, min: 3, max: 2 }
    ]
    await c.run('local', 'inputs.report', { video: [{ id: 'phone:p1', name: 'Pixel (phone)', facing: 'environment', camera }], audio: [] })
    expect(c.state.inputs.video[0].camera?.map((x) => x.key)).toEqual(['exposure', 'shutter'])
    await c.run('local', 'phone.camera', { device: 'phone:p1', set: { exposure: 'manual', shutter: 20 } })
    expect(c.state.phoneSets?.['phone:p1']).toEqual({ set: { exposure: 'manual', shutter: 20 }, seq: 1 })
    expect(c.state.inputs.video[0].camera?.[1].value).toBe(20)
    await expect(c.run('local', 'phone.camera', { device: 'phone:p1', set: { flash: 1 } as never })).rejects.toThrow(/Not a phone camera setting/)
  })
})
