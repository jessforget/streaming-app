import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { amfDecode, amfEncode, parseAvcConfig, RtmpReceiver, rtmpId, toAnnexB, type RtmpPicture } from '../src/server/rtmp'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpeg = require('ffmpeg-static') as string | null

describe('camera receiver (RTMP)', () => {
  it('names cameras by their stream key', () => {
    expect(rtmpId('GoPro Hero 12!')).toBe('rtmp-gopro-hero-12')
    expect(rtmpId('')).toBe('rtmp-camera')
  })

  it('reads and writes commands', () => {
    const b = amfEncode('connect', 1, { app: 'live', n: 2 }, null)
    expect(amfDecode(b)).toEqual(['connect', 1, { app: 'live', n: 2 }, null])
  })

  it('turns camera H.264 into pictures the decoder takes', () => {
    const rec = Buffer.from([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 3, 0x67, 1, 2, 1, 0, 2, 0x68, 3])
    const cfg = parseAvcConfig(rec)!
    expect(cfg.codec).toBe('avc1.640028')
    expect(cfg.lengthSize).toBe(4)
    expect([...cfg.params]).toEqual([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3])
    expect([...toAnnexB(Buffer.from([0, 0, 0, 2, 0x65, 9, 0, 0, 0, 1, 0x41]), 4)]).toEqual([0, 0, 0, 1, 0x65, 9, 0, 0, 0, 1, 0x41])
  })

  it.skipIf(!ffmpeg)('lists a camera that streams to it, by its key, and passes on its pictures', async () => {
    const rx = new RtmpReceiver({ port: 19361, host: '127.0.0.1' })
    await rx.start()
    try {
      const pics: RtmpPicture[] = []
      let codec = ''
      const seen = new Promise<void>((resolve) => {
        rx.onChange(() => {
          const s = rx.list().find((x) => x.id === 'rtmp-gopro')
          if (s?.codec && !codec) {
            rx.subscribe('rtmp-gopro', (p) => pics.push(p), (c) => (codec = c))
            resolve()
          }
        })
      })
      const send = spawn(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '3',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-f', 'flv', 'rtmp://127.0.0.1:19361/live/GoPro'])
      await seen
      await new Promise((r) => send.on('close', r))
      expect(codec).toMatch(/^avc1\./)
      expect(pics.length).toBeGreaterThan(20)
      expect(pics.some((p) => p.key)).toBe(true)
      // Key pictures carry the settings, so the decoder can start there.
      const key = pics.find((p) => p.key)!
      expect(key.data[4] & 0x1f).toBe(7)
      await new Promise((r) => setTimeout(r, 300))
      expect(rx.list()).toEqual([])
    } finally {
      await rx.stop()
    }
  }, 20_000)
})
