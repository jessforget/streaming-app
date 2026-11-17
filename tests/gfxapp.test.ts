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

  it('knows when the streaming app has the graphics live', async () => {
    const ctl = new AbortController()
    await fetch(`${base}/events?role=stream`, { signal: ctl.signal })
    await fetch(`${base}/api/stream`, { method: 'POST', body: JSON.stringify({ live: true }) })
    expect((await state()).stream).toEqual({ connected: true, live: true })
    ctl.abort()
    await new Promise((r) => setTimeout(r, 100))
    expect((await state()).stream).toEqual({ connected: false, live: false })
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
