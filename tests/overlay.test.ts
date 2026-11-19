import { beforeEach, describe, expect, it } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { OVERLAY_ID, ensureOverlay, isOverlay, layerOnAir, linkedNames, overlayOver, scenesOnAir, showScenes } from '../src/shared/state'

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

  it('links an overlay to scenes: then it shows only while one of them is in Live', async () => {
    const { layerId: lt } = (await c.run('local', 'layer.add', { sceneId: OVERLAY_ID, kind: 'graphics', url: 'http://gfx:8765/live' })) as { layerId: string }
    const { layerId: logo } = (await c.run('local', 'layer.add', { sceneId: OVERLAY_ID, kind: 'image', url: 'logo.png' })) as { layerId: string }
    await c.run('local', 'overlay.link', { layerId: lt, sceneId: 'live', on: true })
    const ids = (sceneId: string) => overlayOver(c.state, sceneId)?.layers.map((l) => l.id) ?? []
    expect(ids('live')).toEqual(expect.arrayContaining([lt, logo]))
    expect(ids('starting')).toEqual([logo])
    const overlay = c.state.scenes.find(isOverlay)!
    const layer = overlay.layers.find((l) => l.id === lt)!
    expect(linkedNames(c.state, layer)).toBe(c.state.scenes.find((s) => s.id === 'live')!.name)
    const onAir = (programSceneId: string) => layerOnAir({ ...c.state, programSceneId }, overlay, layer, scenesOnAir({ ...c.state, programSceneId }))
    expect(onAir('live')).toBe(true)
    expect(onAir('starting')).toBe(false)
    // A scene that hides the Overlay still shows what is linked to it.
    await c.run('local', 'scene.setHideOverlay', { sceneId: 'live', hide: true })
    expect(ids('live')).toEqual([lt])
    // Unlinked: every scene again.
    await c.run('local', 'overlay.link', { layerId: lt, sceneId: 'live', on: false })
    expect(c.state.scenes.find(isOverlay)!.layers.find((l) => l.id === lt)!.onlyIn).toBeUndefined()
    expect(ids('starting')).toEqual(expect.arrayContaining([lt, logo]))
  })

  it('forgets the link when its scene is removed', async () => {
    const { layerId } = (await c.run('local', 'layer.add', { sceneId: OVERLAY_ID, kind: 'text', text: 'Hi' })) as { layerId: string }
    await c.run('local', 'overlay.link', { layerId, sceneId: 'playback', on: true })
    await c.run('local', 'scene.remove', { sceneId: 'playback' })
    expect(c.state.scenes.find(isOverlay)!.layers.find((l) => l.id === layerId)!.onlyIn).toBeUndefined()
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
