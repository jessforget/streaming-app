import { describe, expect, it } from 'vitest'
import { AccessUnits, cleanCams, codecFromUnit, rtspUrl } from '../src/server/netcams'

const nal = (type: number, first = true, long = false) =>
  Buffer.from([...(long ? [0, 0, 0, 1] : [0, 0, 1]), type, first ? 0x88 : 0x08, 0x11, 0x22])

describe('network cameras', () => {
  it('turns an address into the Z CAM stream link', () => {
    expect(rtspUrl('192.168.101.40')).toBe('rtsp://192.168.101.40/live_stream')
    expect(rtspUrl('http://192.168.101.40/')).toBe('rtsp://192.168.101.40/live_stream')
    expect(rtspUrl('rtsp://10.0.0.5:554/stream1')).toBe('rtsp://10.0.0.5:554/stream1')
  })

  it('keeps only safe camera entries', () => {
    const out = cleanCams([
      { id: 'e2', name: 'Z CAM E2', address: '192.168.101.40' },
      { id: 'bad', name: 'x', address: '1.2.3.4" -y evil' },
      { name: 'No id', address: 'rtsp://cam.local/live' }
    ])
    expect(out.map((c) => c.address)).toEqual(['192.168.101.40', 'rtsp://cam.local/live'])
    expect(out[1].id).toMatch(/^[a-z0-9]+$/)
  })

  it('does not keep cameras that stream to the app (they show up by themselves)', () => {
    const out = cleanCams([{ id: 'kp9h1aym', name: 'FX30', mode: 'receive', port: 1935 }, { id: 'e2', name: 'Z CAM E2', address: '192.168.101.40' }])
    expect(out.map((c) => [c.id, c.mode])).toEqual([['e2', 'pull']])
  })

  it('splits the H.264 stream into whole pictures, across chunk edges', () => {
    const units: { len: number; key: boolean }[] = []
    const au = new AccessUnits((u, key) => units.push({ len: u.length, key }))
    const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28, 0xaa])
    const stream = Buffer.concat([nal(9, true, true), sps, nal(8), nal(5), nal(5, false), nal(9, true, true), nal(1), nal(9, true, true), nal(1), nal(9, true, true)])
    for (let i = 0; i < stream.length; i += 5) au.push(stream.subarray(i, i + 5))
    // The last picture is sent once the next one starts.
    expect(units.map((u) => u.key)).toEqual([true, false])
    expect(units[0].len).toBe(8 + 9 + 7 + 7 + 7)
  })

  it('reads the codec from the stream settings', () => {
    expect(codecFromUnit(Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28, 0xaa, 0, 0, 1, 0x65, 0x88]))).toBe('avc1.42c028')
  })
})
