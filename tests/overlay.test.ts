import { beforeEach, describe, expect, it } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { OVERLAY_ID, ensureOverlay, overlayOver, scenesOnAir, showScenes } from '../src/shared/state'

describe('Overlay', () => {
  let c: Controller
  beforeEach(async () => {
    c = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: defaultState(), now: () => 1000 })
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
  })

  it('takes sources like a scene and sits over every scene that does not hide it', async () => {
    await c.run('local', 'layer.add', { sceneId: OVERLAY_ID, kind: 'graphics', url: 'gfx:8765/live' })
    expect(c.state.overlayOn).toBe(true)
    expect(overlayOver(c.state, 'live')?.id).toBe(OVERLAY_ID)
    expect(scenesOnAir({ ...c.state, programSceneId: 'live' }).has(OVERLAY_ID)).toBe(true)

    await c.run('local', 'scene.setHideOverlay', { sceneId: 'starting', hide: true })
    expect(overlayOver(c.state, 'starting')).toBeNull()
    expect(scenesOnAir({ ...c.state, programSceneId: 'starting' }).has(OVERLAY_ID)).toBe(false)

    await c.run('local', 'overlay.set', { on: false })
    expect(overlayOver(c.state, 'live')).toBeNull()
  })

  it('is not a scene: no card, no Preview or Live, no removing', async () => {
    expect(showScenes(c.state.scenes).some((s) => s.id === OVERLAY_ID)).toBe(false)
    await expect(c.run('local', 'scene.preview', { sceneId: OVERLAY_ID })).rejects.toThrow(/isn’t a scene/)
    await expect(c.run('local', 'scene.remove', { sceneId: OVERLAY_ID })).rejects.toThrow(/isn’t a scene/)
    await expect(c.run('local', 'layer.add', { sceneId: 'live', kind: 'scene', showScene: OVERLAY_ID })).rejects.toThrow(/isn’t a scene/)
  })

  it('is added to setups saved before it existed', () => {
    const old = { scenes: [{ id: 'a', name: 'A', layers: [] }] } as unknown as Parameters<typeof ensureOverlay>[0]
    ensureOverlay(old)
    expect(old.scenes.map((s) => s.id)).toEqual(['a', OVERLAY_ID])
    expect(old.overlayOn).toBe(true)
  })

  it('a stream deck or tablet remote can switch it', async () => {
    await expect(c.run('buttons', 'overlay.set', { on: false })).resolves.toBeTruthy()
  })
})
