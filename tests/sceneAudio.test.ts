import { describe, expect, it } from 'vitest'
import { audible, countdownText, scenesOnAir, type Scene } from '../src/shared/state'

const scene = (id: string, inner?: string): Scene => ({
  id,
  name: id,
  layers: inner ? [{ id: `${id}-in`, name: '', kind: 'scene', visible: true, sceneId: inner }] : []
})

describe('sound that follows the scene', () => {
  it('counts a scene shown inside the Live scene as on air', () => {
    const state = { scenes: [scene('main', 'logo'), scene('logo'), scene('brb')], programSceneId: 'main' }
    expect([...scenesOnAir(state)]).toEqual(['main', 'logo'])
    expect(audible({ scenes: ['logo'] }, scenesOnAir(state))).toBe(true)
    expect(audible({ scenes: ['brb'] }, scenesOnAir(state))).toBe(false)
    expect(audible({}, scenesOnAir(state))).toBe(true)
  })

  it('does not loop forever on scenes that show each other', () => {
    const state = { scenes: [scene('a', 'b'), scene('b', 'a')], programSceneId: 'a' }
    expect(scenesOnAir(state).size).toBe(2)
  })
})

describe('countdown', () => {
  it('counts minutes from when the scene went on air', () => {
    expect(countdownText({ minutes: 5 }, 60_000, 0)).toBe('Starting in 04:00')
    expect(countdownText({ minutes: 1, text: 'Back in {time}!' }, 61_000, 0)).toBe('Back in 00:00!')
  })

  it('counts to a time of day', () => {
    const now = new Date(2026, 10, 14, 19, 0, 0).getTime()
    expect(countdownText({ until: '19:30', text: '{time}' }, now, undefined)).toBe('30:00')
    expect(countdownText({ until: '21:00', text: '{time}' }, now, undefined)).toBe('2:00:00')
  })
})
