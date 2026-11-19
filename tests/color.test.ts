import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanGrade, gradePixel, isNeutral, NEUTRAL_GRADE } from '../src/shared/color'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore, MemoryShowStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { SetupFile } from '../src/server/storage'

async function setup(shows = new MemoryShowStore()) {
  const c = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: defaultState(), shows, now: () => 5000 })
  await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
  return c
}

describe('color of the picture that goes out', () => {
  it('leaves colours alone at zero', () => {
    expect(gradePixel(NEUTRAL_GRADE, [0.2, 0.5, 0.8]).map((v) => +v.toFixed(5))).toEqual([0.2, 0.5, 0.8])
  })

  it('exposure, white balance, contrast and saturation move the colours the right way', () => {
    const grey: [number, number, number] = [0.4, 0.4, 0.4]
    expect(gradePixel({ ...NEUTRAL_GRADE, exposure: 1 }, grey)[1]).toBeCloseTo(0.8)
    const warm = gradePixel({ ...NEUTRAL_GRADE, temperature: 100 }, grey)
    expect(warm[0]).toBeGreaterThan(warm[2])
    const magenta = gradePixel({ ...NEUTRAL_GRADE, tint: 100 }, grey)
    expect(magenta[1]).toBeLessThan(magenta[0])
    expect(gradePixel({ ...NEUTRAL_GRADE, contrast: 100 }, [0.25, 0.25, 0.25])[0]).toBeCloseTo(0)
    const bw = gradePixel({ ...NEUTRAL_GRADE, saturation: -100 }, [1, 0, 0])
    expect(bw[0]).toBeCloseTo(bw[1])
  })

  it('keeps values inside their limits', () => {
    expect(cleanGrade({ exposure: 9, contrast: -500, tint: 'x' })).toEqual({ ...NEUTRAL_GRADE, exposure: 2, contrast: -100 })
    expect(isNeutral(undefined)).toBe(true)
  })

  it('is set, reset and saved in the project file', async () => {
    const shows = new MemoryShowStore()
    const c = await setup(shows)
    await c.run('local', 'show.save', { name: 'Grade' })
    await c.run('local', 'color.set', { exposure: 0.5, saturation: 20 })
    await c.run('local', 'color.set', { temperature: -30 })
    expect(c.state.color).toEqual({ ...NEUTRAL_GRADE, exposure: 0.5, saturation: 20, temperature: -30 })
    expect(c.state.show.changed).toBe(true)
    await expect(c.run('local', 'color.set', { exposure: 5 })).rejects.toThrow()
    await c.run('local', 'show.save')
    await c.run('local', 'color.reset')
    expect(c.state.color).toBeUndefined()
    await c.run('local', 'show.open', { file: 'Grade.show.json' })
    expect(c.state.color).toMatchObject({ exposure: 0.5, saturation: 20, temperature: -30 })
  })

  it('comes back after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'color-'))
    try {
      const file = new SetupFile(join(dir, 'setup.json'))
      const s = defaultState()
      s.color = { ...NEUTRAL_GRADE, contrast: 15 }
      file.save(s)
      expect(file.load().color).toMatchObject({ contrast: 15 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
