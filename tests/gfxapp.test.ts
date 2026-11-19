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

  it('tells the About box its version, developer and address', async () => {
    const info = await fetch(`${base}/api/info`).then((r) => r.json())
    expect(info.about).toMatchObject({ name: 'Gfx App', developer: 'Jess Limot' })
    expect(info.about.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(info.port).toBe(gfx.port)
    for (const a of info.named) expect(a).toEqual({ name: expect.any(String), ip: expect.any(String) })
  })

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

  it('keeps the rundown grouped by kind: lower thirds, videos, photos, windows, color bars', async () => {
    await doit({ action: 'add', item: { kind: 'bars', name: 'Bars' } })
    await doit({ action: 'add', item: { kind: 'video', path: join(dir, 'clip.mp4') } })
    await doit({ action: 'add', item: { kind: 'lowerthird', name: 'Second', title: 'T' } })
    await doit({ action: 'add', item: { kind: 'photos', paths: [join(dir, 'pics')] } })
    await doit({ action: 'add', item: { kind: 'lowerthird', name: 'Third', title: 'T' } })
    const s = await state()
    expect(s.items.map((i) => i.kind)).toEqual(['lowerthird', 'lowerthird', 'lowerthird', 'video', 'photos', 'bars'])
    // Moving stays inside the group.
    const video = s.items.find((i) => i.kind === 'video')!
    await doit({ action: 'move', id: video.id, up: true })
    expect((await state()).items.map((i) => i.kind)).toEqual(['lowerthird', 'lowerthird', 'lowerthird', 'video', 'photos', 'bars'])
  })

  it('knows when the streaming app has the graphics live', async () => {
    const ctl = new AbortController()
    await fetch(`${base}/events?role=stream`, { signal: ctl.signal })
    await fetch(`${base}/api/stream`, { method: 'POST', body: JSON.stringify({ live: true }) })
    expect((await state()).stream).toEqual({ connected: true, live: true, only: '', picture: false })
    // Linked to one scene: the gfx app shows which.
    await fetch(`${base}/api/stream`, { method: 'POST', body: JSON.stringify({ live: false, only: 'Main show' }) })
    expect((await state()).stream).toEqual({ connected: true, live: false, only: 'Main show', picture: false })
    ctl.abort()
    await new Promise((r) => setTimeout(r, 100))
    expect((await state()).stream).toEqual({ connected: false, live: false, only: '', picture: false })
  })

  it('cues a video to the stream and follows how it goes', async () => {
    writeFileSync(join(dir, 'ad.mp4'), Buffer.alloc(100))
    const v = await doit({ action: 'add', item: { kind: 'video', path: join(dir, 'ad.mp4') } })
    expect((await doit({ action: 'cue', id: 'item-1' })).error).toMatch(/Only videos/)
    await doit({ action: 'cue', id: v.result })
    let s = (await state()) as State & { cue: { take: number; status: string; items: { id: string; name: string }[] } }
    expect(s.cue).toMatchObject({ items: [{ id: v.result, name: 'ad' }], take: 1, status: 'waiting' })
    // A second video joins the break (a new take); the same one twice is refused; order can change.
    writeFileSync(join(dir, 'ad2.mp4'), Buffer.alloc(100))
    const v2 = await doit({ action: 'add', item: { kind: 'video', path: join(dir, 'ad2.mp4') } })
    expect((await doit({ action: 'cue', id: v.result })).error).toMatch(/already in the break/)
    expect((await doit({ action: 'cue', id: v2.result })).result).toBe(2)
    await doit({ action: 'cue-move', index: 1, up: true })
    s = (await state()) as typeof s
    expect(s.cue).toMatchObject({ take: 3, items: [{ id: v2.result }, { id: v.result }] })
    await doit({ action: 'cue-move', index: 0, to: 1 }) // dragged: back where it was
    expect(((await state()) as typeof s).cue.items.map((x) => x.id)).toEqual([v.result, v2.result])
    await doit({ action: 'cue-move', index: 1, to: 0 })
    await doit({ action: 'uncue', index: 0 })
    s = (await state()) as typeof s
    expect(s.cue).toMatchObject({ take: 6, items: [{ id: v.result }] })
    const tell = (b: object) => fetch(`${base}/api/cue`, { method: 'POST', body: JSON.stringify(b) })
    await tell({ take: 6, status: 'onair', at: 0, pos: 3, dur: 30, left: 27 })
    s = (await state()) as typeof s
    expect(s.cue).toMatchObject({ status: 'onair', at: 0, pos: 3, dur: 30, left: 27 })
    expect((await doit({ action: 'uncue' })).error).toMatch(/on air/)
    await tell({ take: 99, status: 'done' }) // an old cue: ignored
    expect(((await state()) as typeof s).cue.status).toBe('onair')
    // On air, a video joins the end of the break: a new take, still on air, pending until the streaming app has it.
    await doit({ action: 'cue', id: v2.result, index: 0 }) // (not before the one playing)
    s = (await state()) as typeof s
    expect(s.cue).toMatchObject({ take: 7, status: 'onair', pending: true, liveTake: 6, items: [{ id: v.result }, { id: v2.result }] })
    expect((await doit({ action: 'uncue', index: 0 })).error).toMatch(/playing/)
    await tell({ take: 6, status: 'onair', at: 0, pos: 4, dur: 30 }) // the take on air still reports
    expect(((await state()) as typeof s).cue).toMatchObject({ take: 7, pending: true, pos: 4 })
    await tell({ take: 7, status: 'onair', at: 0, pos: 5, dur: 30 }) // the streaming app has the longer break
    expect(((await state()) as typeof s).cue).toMatchObject({ pending: false, liveTake: 7 })
    await tell({ take: 7, status: 'done' })
    // After a break has played, cueing starts a new one.
    await doit({ action: 'cue', id: v2.result })
    expect(((await state()) as typeof s).cue).toMatchObject({ take: 8, items: [{ id: v2.result }] })
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
