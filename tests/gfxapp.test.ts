import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startServer } = require('../gfx-app/server.cjs') as {
  startServer: (o: object) => Promise<{ port: number; close: () => void }>
}

type State = { items: { id: string; kind: string; name: string; file?: string; count?: number; ok?: boolean }[]; previewId: string | null; onAir: { id: string; take: number } | null; stream: { connected: boolean; live: boolean } }

describe('gfx app server', () => {
  let dir: string
  let gfx: { port: number; close: () => void }
  let base: string
  const doit = (body: object) => fetch(`${base}/api/do`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json())
  /** The first state message on /events. */
  const state = async (role = ''): Promise<State> => {
    const ctl = new AbortController()
    const r = await fetch(`${base}/events${role}`, { signal: ctl.signal })
    const reader = r.body!.getReader()
    let text = ''
    while (!/data: .*\n\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value)
    ctl.abort()
    return JSON.parse(/data: (.*)\n\n/.exec(text)![1])
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gfx-'))
    mkdirSync(join(dir, 'pics'))
    for (const n of ['b.png', 'a.png', 'notes.txt']) writeFileSync(join(dir, 'pics', n), 'x')
    writeFileSync(join(dir, 'clip.mp4'), Buffer.alloc(1000, 7))
    gfx = await startServer({ port: 0, dataDir: dir, log: () => {} })
    base = `http://127.0.0.1:${gfx.port}`
  })
  afterEach(() => gfx.close())

  it('starts with a lower third in Preview; Take and Hide', async () => {
    let s = await state()
    expect(s.items.map((i) => i.kind)).toEqual(['lowerthird'])
    expect(s.previewId).toBe('item-1')
    await doit({ action: 'take' })
    s = await state()
    expect(s.onAir).toEqual({ id: 'item-1', take: 1 })
    // A page asking to hide an older take changes nothing.
    await doit({ action: 'hide', take: 0 })
    expect((await state()).onAir).not.toBeNull()
    await doit({ action: 'hide' })
    expect((await state()).onAir).toBeNull()
  })

  it('adds videos and slideshows (a folder adds its pictures in order) and serves only those files', async () => {
    const v = await doit({ action: 'add', item: { kind: 'video', path: join(dir, 'clip.mp4') } })
    const p = await doit({ action: 'add', item: { kind: 'photos', paths: [join(dir, 'pics')] } })
    const s = await state()
    const video = s.items.find((i) => i.id === v.result)!
    const photos = s.items.find((i) => i.id === p.result)!
    expect(video).toMatchObject({ kind: 'video', name: 'clip', file: 'clip.mp4', ok: true })
    expect(photos).toMatchObject({ kind: 'photos', count: 2 })
    expect(JSON.stringify(s)).not.toContain(dir) // no paths go out
    const part = await fetch(`${base}/media/${v.result}`, { headers: { range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect((await part.arrayBuffer()).byteLength).toBe(10)
    expect((await fetch(`${base}/media/${p.result}/1`)).status).toBe(200)
    expect((await fetch(`${base}/media/${p.result}/5`)).status).toBe(404)
    expect((await fetch(`${base}/media/nope`)).status).toBe(404)
    expect((await doit({ action: 'add', item: { kind: 'video', path: join(dir, 'pics', 'notes.txt') } })).error).toMatch(/video file/)
  })

  it('knows when the streaming app has the graphics live', async () => {
    const ctl = new AbortController()
    await fetch(`${base}/events?role=stream`, { signal: ctl.signal })
    await fetch(`${base}/api/stream`, { method: 'POST', body: JSON.stringify({ live: true }) })
    expect((await state()).stream).toEqual({ connected: true, live: true, picture: false })
    ctl.abort()
    await new Promise((r) => setTimeout(r, 100))
    expect((await state()).stream).toEqual({ connected: false, live: false, picture: false })
  })

  it('cues a video to the stream and follows how it goes', async () => {
    writeFileSync(join(dir, 'ad.mp4'), Buffer.alloc(100))
    const v = await doit({ action: 'add', item: { kind: 'video', path: join(dir, 'ad.mp4') } })
    expect((await doit({ action: 'cue', id: 'item-1' })).error).toMatch(/Only videos/)
    await doit({ action: 'cue', id: v.result })
    let s = (await state()) as State & { cue: { take: number; status: string; name: string } }
    expect(s.cue).toMatchObject({ id: v.result, take: 1, name: 'ad', status: 'waiting' })
    const tell = (b: object) => fetch(`${base}/api/cue`, { method: 'POST', body: JSON.stringify(b) })
    await tell({ take: 1, status: 'onair', pos: 3, dur: 30 })
    s = (await state()) as typeof s
    expect(s.cue).toMatchObject({ status: 'onair', pos: 3, dur: 30 })
    expect((await doit({ action: 'uncue' })).error).toMatch(/on air/)
    await tell({ take: 99, status: 'done' }) // an old cue: ignored
    expect(((await state()) as typeof s).cue.status).toBe('onair')
    await tell({ take: 1, status: 'done' })
    await doit({ action: 'uncue' })
    expect(((await state()) as typeof s).cue).toBeNull()
  })

  it('takes the stream’s Live picture and shows it on /program.mjpg', async () => {
    expect((await fetch(`${base}/api/program`, { method: 'POST', body: 'nope' })).status).toBe(400)
    const jpg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    expect((await fetch(`${base}/api/program`, { method: 'POST', body: jpg })).status).toBe(204)
    expect((await state()).stream).toMatchObject({ picture: true })
    const ctl = new AbortController()
    const r = await fetch(`${base}/program.mjpg`, { signal: ctl.signal })
    expect(r.headers.get('content-type')).toContain('multipart/x-mixed-replace')
    const first = new TextDecoder('latin1').decode((await r.body!.getReader().read()).value)
    expect(first).toContain('Content-Type: image/jpeg')
    ctl.abort()
  })

  it('next and previous move Preview down and up the rundown', async () => {
    await doit({ action: 'add', item: { kind: 'lowerthird', name: 'Dana Cruz', title: 'Worship leader' } })
    let s = await state()
    expect(s.previewId).toBe('item-2')
    await doit({ action: 'next', back: true })
    s = await state()
    expect(s.previewId).toBe('item-1')
    await doit({ action: 'next' })
    expect((await state()).previewId).toBe('item-2')
  })
})
