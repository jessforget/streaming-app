import { describe, expect, it } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { showFromState, applyShow, readShow } from '../src/core/show'
import { QUALITY_PRESETS, gbPerHour, presetFor, recordPresetFor } from '../src/shared/presets'
import type { QualityPreset } from '../src/shared/presets'
import { avcCodec } from '../src/renderer/src/studio/gpuOutput'

describe('recording quality', () => {
  it('"Same as stream" is exactly the stream preset', () => {
    expect(recordPresetFor('low', 'ntsc', 'stream')).toEqual(presetFor('low', 'ntsc'))
    expect(recordPresetFor('high', 'pal')).toEqual(presetFor('high', 'pal'))
  })

  it('higher levels keep the picture size and frame rate but raise the bitrate', () => {
    for (const q of ['low', 'medium', 'high'] as const) {
      const s = presetFor(q, 'pal')
      let last = s.videoKbps
      for (const r of ['high', 'veryhigh', 'best'] as const) {
        const p = recordPresetFor(q, 'pal', r)
        expect([p.width, p.height, p.fps]).toEqual([s.width, s.height, s.fps])
        expect(p.videoKbps).toBeGreaterThanOrEqual(last)
        expect(p.videoKbps).toBeLessThanOrEqual(60_000)
        expect(p.exact).toBe(true)
        last = p.videoKbps
      }
    }
    expect(recordPresetFor('medium', 'ntsc', 'high').videoKbps).toBe(12_000)
    expect(recordPresetFor('high', 'ntsc', 'best').videoKbps).toBe(60_000)
  })

  it('picks an H.264 level that allows the bitrate', () => {
    const p = (o: Partial<QualityPreset>) => ({ ...QUALITY_PRESETS.medium, ...o })
    expect(avcCodec(QUALITY_PRESETS.low)).toBe('avc1.64001f')
    expect(avcCodec(QUALITY_PRESETS.medium)).toBe('avc1.640028')
    expect(avcCodec(QUALITY_PRESETS.high)).toBe('avc1.64002a')
    expect(avcCodec(p({ videoKbps: 40_000 }))).toBe('avc1.64002a')
    expect(avcCodec(recordPresetFor('low', 'ntsc', 'best'))).toBe('avc1.640028')
  })

  it('says how big the files get', () => {
    expect(gbPerHour(recordPresetFor('medium', 'ntsc', 'high'))).toBeCloseTo(5.54, 1)
  })

  it('is set by a command, used for the recording, and kept in the project', async () => {
    const engine = new SimEngine()
    const presets: QualityPreset[] = []
    const start = engine.startRecording.bind(engine)
    engine.startRecording = async (folder, format, preset) => {
      presets.push(preset)
      return start(folder, format, preset)
    }
    const c = new Controller({ engine, keys: new MemoryKeyStore(), initial: defaultState(), now: () => 1000 })
    await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
    expect(c.state.recording.quality).toBe('stream')
    await expect(c.run('local', 'settings.setRecordQuality', { quality: 'ultra' })).rejects.toThrow('quality must be')
    await c.run('local', 'settings.setRecordQuality', { quality: 'veryhigh' })
    await c.run('local', 'record.start')
    expect(presets[0].videoKbps).toBe(recordPresetFor(c.state.stream.quality, c.state.stream.family, 'veryhigh').videoKbps)
    await expect(c.run('local', 'settings.setRecordQuality', { quality: 'best' })).rejects.toThrow('Stop recording first')
    await c.run('local', 'record.stop')

    const show = readShow(JSON.parse(JSON.stringify(showFromState(c.state, 'Test', 1))))
    expect(show.recordQuality).toBe('veryhigh')
    const fresh = defaultState()
    applyShow(fresh, show, 1)
    expect(fresh.recording.quality).toBe('veryhigh')
  })
})
