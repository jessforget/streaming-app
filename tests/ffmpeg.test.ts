import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { QUALITY_PRESETS } from '../src/shared/presets'
import type { StreamTarget } from '../src/core/ports'
import { FfmpegOutput, findFfmpeg, ingestAddress, plainError, recordArgs, streamArgs } from '../src/server/ffmpeg'

const preset = QUALITY_PRESETS.low
const target = (over: Partial<StreamTarget>): StreamTarget => ({
  destinationId: 'd',
  platform: 'youtube',
  url: 'rtmp://a.rtmp.youtube.com/live2',
  key: 'abcd-1234',
  vertical: false,
  ...over
})

describe('ffmpeg arguments', () => {
  it('joins the server address and the key', () => {
    expect(ingestAddress(target({ url: 'rtmps://live-api-s.facebook.com:443/rtmp/' }))).toBe('rtmps://live-api-s.facebook.com:443/rtmp/abcd-1234')
  })

  it('encodes once and sends to every platform, with a keyframe every 2 seconds', () => {
    const args = streamArgs([target({}), target({ platform: 'facebook', url: 'rtmps://fb/rtmp' })], preset, 'libx264')
    expect(args).toContain('tee')
    expect(args.at(-1)).toBe('[f=flv:onfail=ignore]rtmp://a.rtmp.youtube.com/live2/abcd-1234|[f=flv:onfail=ignore]rtmps://fb/rtmp/abcd-1234')
    expect(args[args.indexOf('-g') + 1]).toBe(String(preset.fps * 2))
    expect(args.filter((a) => a === '-c:v')).toHaveLength(1)
  })

  it('gives Instagram its own vertical picture', () => {
    const args = streamArgs([target({}), target({ platform: 'instagram', vertical: true, url: 'rtmps://ig/rtmp' })], preset, 'libx264')
    expect(args.join(' ')).toContain('split=2')
    expect(args.at(-1)).toContain("select=\\'v:1,a\\'")
  })

  it('escapes characters that mean something to the tee output', () => {
    const args = streamArgs([target({ key: 'a|b[c]' })], preset, 'libx264')
    expect(args.at(-1)).toContain('a\\|b\\[c\\]')
  })

  it('keeps the browser’s picture in recordings when it can', () => {
    expect(recordArgs('x.mkv', 'mkv', 'vp8', preset, 'libx264')).toContain('copy')
    const mp4 = recordArgs('x.mp4', 'mp4', 'vp8', preset, 'libx264')
    expect(mp4[mp4.indexOf('-c:v') + 1]).toBe('libx264')
    const h264 = recordArgs('x.mp4', 'mp4', 'h264', preset, 'libx264')
    expect(h264[h264.indexOf('-c:v') + 1]).toBe('copy')
  })

  it('explains failures in plain words', () => {
    expect(plainError(['rtmp://x: Connection refused'])).toMatch(/couldn't reach the platform/)
    expect(plainError(['av_interleaved_write_frame(): Broken pipe'])).toMatch(/stream key/)
  })
})

const ffmpeg = findFfmpeg()

describe.skipIf(!ffmpeg)('ffmpeg for real', () => {
  const dir = mkdtempSync(join(tmpdir(), 'streaming-app-test-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /** A short WebM like the one the studio page sends (VP8 + Opus). */
  function webm(): Buffer {
    const file = join(dir, 'in.webm')
    const r = spawnSync(ffmpeg!, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
      '-t', '2', '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-y', file
    ])
    if (r.status !== 0) throw new Error(r.stderr.toString())
    return readFileSync(file)
  }

  function probe(file: string): string {
    return spawnSync(ffmpeg!, ['-hide_banner', '-i', file]).stderr.toString()
  }

  async function feed(args: string[]) {
    const error = await new Promise<string | null>((resolve) => {
      const out = new FfmpegOutput(ffmpeg!, args, resolve)
      const data = webm()
      for (let i = 0; i < data.length; i += 16_384) out.write(data.subarray(i, i + 16_384))
      void out.stop()
    })
    return error
  }

  it('records the studio’s video to an MP4 file', async () => {
    const file = join(dir, 'Recording.mp4')
    expect(await feed(recordArgs(file, 'mp4', 'vp8', preset, 'libx264'))).toBeNull()
    const info = probe(file)
    expect(info).toMatch(/Video: h264/)
    expect(info).toMatch(/Audio: aac/)
  }, 60_000)

  it('sends a wide picture and Instagram’s vertical one in one go', async () => {
    const targets = [target({ url: dir, key: 'wide.flv' }), target({ platform: 'instagram', vertical: true, url: dir, key: 'tall.flv' })]
    expect(await feed(streamArgs(targets, preset, 'libx264'))).toBeNull()
    expect(probe(join(dir, 'wide.flv'))).toMatch(new RegExp(`${preset.width}x${preset.height}`))
    expect(probe(join(dir, 'tall.flv'))).toMatch(/720x1280/)
  }, 60_000)
})
