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
})
