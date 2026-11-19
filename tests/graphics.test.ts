import { describe, expect, it, beforeEach } from 'vitest'
import { Controller, graphicsUrl } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { feedSpec, toRgba } from '../src/renderer/src/studio/graphics'
import type { Layer } from '../src/shared/state'

function setup() {
  const c = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: defaultState(), now: () => 1000 })
  return c
}

describe('Graphics (network) sources', () => {
  let c: Controller
  beforeEach(async () => {
    c = setup()
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
  })

  it('adds a graphics source with its address, size and frame rate', async () => {
    const r = (await c.run('local', 'layer.add', {
      sceneId: 'live',
      kind: 'graphics',
      url: '192.168.101.50:8080/live',
      size: '720p',
      fps: 60
    })) as { layerId: string }
    const layer = c.state.scenes.find((s) => s.id === 'live')!.layers[0]
    expect(layer.id).toBe(r.layerId)
    expect(layer).toMatchObject({ kind: 'graphics', name: 'Graphics', url: 'http://192.168.101.50:8080/live', size: '720p', fps: 60, visible: true })
  })

  it('goes back to the stream’s frame rate with fps 0', async () => {
    const { layerId } = (await c.run('local', 'layer.add', { sceneId: 'live', kind: 'graphics', url: 'http://gfx:8080/', fps: 60 })) as { layerId: string }
    await c.run('local', 'layer.update', { sceneId: 'live', layerId, fps: 0 })
    expect(c.state.scenes.find((s) => s.id === 'live')!.layers[0].fps).toBeUndefined()
  })

  it('refuses addresses that are not web pages, and sizes it can’t draw', async () => {
    await expect(c.run('local', 'layer.add', { sceneId: 'live', kind: 'graphics', url: 'file:///C:/x.html' })).rejects.toThrow('http:// or https://')
    await expect(c.run('local', 'layer.add', { sceneId: 'live', kind: 'graphics', url: 'http://gfx/', size: '4k' })).rejects.toThrow('size must be')
  })

  it('adds http:// when it is left out', () => {
    expect(graphicsUrl('10.0.0.5:8080/live')).toBe('http://10.0.0.5:8080/live')
    expect(graphicsUrl('https://gfx.local/live')).toBe('https://gfx.local/live')
  })
})

describe('graphics pages', () => {
  const state = defaultState()
  const layer = (p: Partial<Layer>): Layer => ({ id: 'g', name: 'G', kind: 'graphics', visible: true, ...p })

  it('shares one page between sources with the same address, size and frame rate', () => {
    const a = feedSpec(layer({ url: 'http://gfx:8080/live' }), state)
    const b = feedSpec(layer({ id: 'other', url: 'http://gfx:8080/live' }), state)
    expect(a?.key).toBe(b?.key)
    expect(a).toMatchObject({ width: 1920, height: 1080 })
    expect(feedSpec(layer({ url: 'http://gfx:8080/live', size: '720p' }), state)?.key).not.toBe(a?.key)
  })

  it('has no page without a web address', () => {
    expect(feedSpec(layer({}), state)).toBeNull()
    expect(feedSpec(layer({ url: 'C:\\graphics.html' }), state)).toBeNull()
    expect(feedSpec(layer({ kind: 'image', url: 'http://gfx/logo.png' }), state)).toBeNull()
  })

  it('turns the desktop’s BGRA premultiplied pixels into plain RGBA', () => {
    // opaque blue, see-through, half-see-through white
    const src = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 128, 128, 128, 128])
    const out = new Uint8ClampedArray(12)
    toRgba(src, out)
    expect(Array.from(out.slice(0, 4))).toEqual([0, 0, 255, 255])
    expect(Array.from(out.slice(4, 8))).toEqual([0, 0, 0, 0])
    expect(Array.from(out.slice(8, 12))).toEqual([255, 255, 255, 128])
  })
})
