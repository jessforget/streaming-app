import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
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
    expect(s.onAir).toMatchObject({ id: 'item-1', take: 1 })
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

  it('a video taken while no streaming app was connected is taken off air when one connects (it would cover the stream)', async () => {
    const v = (await doit({ action: 'add', item: { kind: 'video', path: join(dir, 'clip.mp4') } })).result
    await doit({ action: 'take', id: v })
    expect((await state()).onAir?.id).toBe(v)
    // The streaming app's graphics page connects: its very first state has nothing on air.
    const ctl = new AbortController()
    const first = await state('?role=stream')
    expect(first.onAir).toBeNull()
    expect((first as State & { held: { name: string } }).held).toMatchObject({ name: 'clip' })
    // Taken while it is connected (or after a short drop): it stays, as the operator meant it for the stream.
    await fetch(`${base}/events?role=stream`, { signal: ctl.signal })
    await doit({ action: 'take', id: v })
    ctl.abort()
    await new Promise((r) => setTimeout(r, 100))
    expect((await state('?role=stream')).onAir?.id).toBe(v)
  })

  it('a lower third taken before the streaming app connected stays on air (it waits for the stream)', async () => {
    await doit({ action: 'take', id: 'item-1' })
    expect((await state('?role=stream')).onAir?.id).toBe('item-1')
  })

  it('color bars go off air once the stream moves away from them (graphics taken off Live, or a break on air)', async () => {
    const bars = (await doit({ action: 'add', item: { kind: 'bars', name: 'Bars' } })).result
    const ctl = new AbortController()
    await fetch(`${base}/events?role=stream`, { signal: ctl.signal })
    const stream = (live: boolean) => fetch(`${base}/api/stream`, { method: 'POST', body: JSON.stringify({ live }) })
    await stream(true)
    await doit({ action: 'take', id: bars })
    await stream(true) // still live: stays
    expect((await state()).onAir?.id).toBe(bars)
    await stream(false) // e.g. a commercial break: the bars are gone for good
    expect((await state()).onAir).toBeNull()
    await stream(true)
    expect((await state()).onAir).toBeNull()
    // A lower third stays through the same.
    await doit({ action: 'take', id: 'item-1' })
    await stream(false)
    expect((await state()).onAir?.id).toBe('item-1')
    // A cued break going on air also takes the bars off.
    writeFileSync(join(dir, 'ad.mp4'), Buffer.alloc(100))
    const v = (await doit({ action: 'add', item: { kind: 'video', path: join(dir, 'ad.mp4') } })).result
    await doit({ action: 'take', id: bars })
    await doit({ action: 'cue', id: v })
    const take = ((await state()) as State & { cue: { take: number } }).cue.take
    await fetch(`${base}/api/cue`, { method: 'POST', body: JSON.stringify({ take, status: 'onair', at: 0 }) })
    expect((await state()).onAir).toBeNull()
    ctl.abort()
  })

  it('File menu: save a project, start a new rundown, open it again; it saves itself; reopens after a restart', async () => {
    let s = (await state()) as State & { project: { name: string; file: string; changed: boolean } }
    expect(s.project).toMatchObject({ name: 'Untitled rundown', file: '' })
    expect((await doit({ action: 'project.save' })).error).toMatch(/name/)
    expect((await doit({ action: 'project.save', name: 'Sunday service' })).result).toEqual({ file: 'Sunday service.gfx.json' })
    s = (await state()) as typeof s
    expect(s.project).toMatchObject({ name: 'Sunday service', file: 'Sunday service.gfx.json', changed: false })
    // A change saves itself a moment later.
    await doit({ action: 'add', item: { kind: 'lowerthird', name: 'Pastor', title: 'Host' } })
    expect(((await state()) as typeof s).project.changed).toBe(true)
    await new Promise((r) => setTimeout(r, 1800))
    expect(((await state()) as typeof s).project.changed).toBe(false)
    // New rundown: empty, the look kept.
    await doit({ action: 'project.new', name: 'Youth night' })
    s = (await state()) as typeof s
    expect(s.items).toEqual([])
    expect(s.project).toMatchObject({ name: 'Youth night', file: '' })
    const list = (await doit({ action: 'project.list' })).result.projects
    expect(list).toMatchObject([{ file: 'Sunday service.gfx.json', name: 'Sunday service', items: 2 }])
    // Not while something is on air.
    await doit({ action: 'add', item: { kind: 'lowerthird', name: 'X', title: 'Y' } })
    await doit({ action: 'take' })
    expect((await doit({ action: 'project.open', file: 'Sunday service.gfx.json' })).error).toMatch(/on air/)
    await doit({ action: 'hide' })
    await doit({ action: 'project.open', file: 'Sunday service.gfx.json' })
    s = (await state()) as typeof s
    expect(s.items.map((i) => i.name)).toEqual(['Sam Rivera', 'Pastor'])
    expect(s.project).toMatchObject({ name: 'Sunday service', changed: false })
    // Export, then import elsewhere.
    const exported = (await doit({ action: 'project.export' })).result
    expect(exported).toMatchObject({ format: 'gfx-app-project', name: 'Sunday service' })
    // Closed and started again: the last project is open.
    gfx.close()
    gfx = await startServer({ port: 0, dataDir: dir, log: () => {} })
    base = `http://127.0.0.1:${gfx.port}`
    s = (await state()) as typeof s
    expect(s.project).toMatchObject({ name: 'Sunday service', file: 'Sunday service.gfx.json', changed: false })
    expect(s.items.map((i) => i.name)).toEqual(['Sam Rivera', 'Pastor'])
    await doit({ action: 'project.import', project: { ...exported, name: 'From USB' } })
    expect(((await state()) as typeof s).project).toMatchObject({ name: 'From USB', file: 'From USB.gfx.json' })
    expect((await doit({ action: 'project.import', project: { nope: 1 } })).error).toMatch(/isn’t a gfx app project/)
    await doit({ action: 'project.delete', file: 'From USB.gfx.json' })
    expect((await doit({ action: 'project.list' })).result.projects.map((x: { name: string }) => x.name)).toEqual(['Sunday service'])
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const st = () => state() as Promise<any>

  it('saves lower-third templates; new lower thirds start with the default one', async () => {
    const t = await doit({ action: 'template.save', name: 'Guest', itemId: 'item-1', look: { style: 'glass', accent: '#ff0000', speed: 'fast' } })
    let s = await st()
    expect(s.templates).toEqual([{ id: t.result, name: 'Guest', look: expect.objectContaining({ style: 'glass', accent: '#ff0000', speed: 'fast' }) }])
    expect(s.items[0].template).toBe(t.result)
    await doit({ action: 'template.default', id: t.result })
    const n = await doit({ action: 'add', item: { kind: 'lowerthird', name: 'New', title: 'One' } })
    s = await st()
    expect(s.items.find((i: { id: string }) => i.id === n.result).template).toBe(t.result)
    // Unknown styles are refused; deleting a template sends its lower thirds back to the shared look.
    await doit({ action: 'template.update', id: t.result, look: { style: 'nope', nameSize: 70 } })
    expect((await st()).templates[0].look).toMatchObject({ style: 'glass', nameSize: 70 })
    expect((await doit({ action: 'template.import', templates: [{ name: 'Guest', look: { style: 'vbar' } }] })).result).toBe(1)
    expect((await st()).templates.map((x: { name: string }) => x.name)).toEqual(['Guest', 'Guest 2'])
    await doit({ action: 'template.delete', id: t.result })
    s = await st()
    expect(s.defaultTemplate).toBe('')
    expect(s.items.every((i: { template: string }) => i.template === '')).toBe(true)
  })

  it('switches the Stays-on graphics and keeps their settings in projects', async () => {
    expect((await doit({ action: 'layer.toggle', layer: 'logo' })).error).toMatch(/logo picture/)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    expect((await fetch(`${base}/api/logo?ext=png`, { method: 'POST', body: png })).status).toBe(200)
    await doit({ action: 'layer.set', layer: 'logo', patch: { on: true, x: 20, y: 150, size: 999 } })
    let s = await st()
    expect(s.layers.logo).toMatchObject({ on: true, x: 20, y: 100, size: 400, url: expect.stringContaining('/media/logo') })
    expect(JSON.stringify(s)).not.toContain(dir)
    expect(Buffer.from(await (await fetch(`${base}${s.layers.logo.url}`)).arrayBuffer())).toEqual(png)
    await doit({ action: 'layer.set', layer: 'ticker', patch: { on: true, lines: ['One', 'Two', 3] } })
    await doit({ action: 'score.add', team: 'a', n: 1 })
    await doit({ action: 'score.add', team: 'a', n: -5 })
    await doit({ action: 'score.add', team: 'b', n: 2 })
    s = await st()
    expect(s.layers.ticker.lines).toEqual(['One', 'Two'])
    expect(s.layers.score).toMatchObject({ sa: 0, sb: 2 })
    await doit({ action: 'score.clock', do: 'start' })
    expect((await st()).layers.score.clockRun).toBe(true)
    await doit({ action: 'project.save', name: 'Game night' })
    const saved = JSON.parse(readFileSync(join(dir, 'projects', 'Game night.gfx.json'), 'utf8'))
    expect(saved.layers.ticker).toMatchObject({ lines: ['One', 'Two'] })
    expect(saved.layers.ticker.on).toBeUndefined()
  })

  it('counts down: a countdown item from Take, and the corner one from when it is switched on', async () => {
    const c = await doit({ action: 'add', item: { kind: 'countdown', minutes: 2 } })
    await doit({ action: 'take', id: c.result })
    let s = await st()
    const left = s.onAir.countdown.endsAt - s.now
    expect(left).toBeGreaterThan(119_000)
    expect(left).toBeLessThanOrEqual(120_000)
    await doit({ action: 'countdown', do: 'add', secs: 60 })
    await doit({ action: 'countdown', do: 'pause' })
    s = await st()
    expect(s.onAir.countdown.pausedLeft).toBeGreaterThan(179_000)
    expect((await doit({ action: 'countdown', target: 'corner', do: 'pause' })).error).toMatch(/off/)
    await doit({ action: 'layer.set', layer: 'corner', patch: { on: true, minutes: 0 } })
    s = await st()
    expect(s.layers.corner.on).toBe(true)
    // Set to hide at 0:00: it goes off by itself.
    await new Promise((r) => setTimeout(r, 1300))
    expect((await st()).layers.corner.on).toBe(false)
  })

  it('takes one hotkey per item', async () => {
    const n = await doit({ action: 'add', item: { kind: 'lowerthird', name: 'B', hotkey: 'F2' } })
    await doit({ action: 'update', id: 'item-1', item: { hotkey: 'F2' } })
    const s = await st()
    expect(s.items.map((i: { hotkey: string }) => i.hotkey)).toEqual(['F2', ''])
    expect(s.items[1].id).toBe(n.result)
  })

  it('shows a viewer comment, leaves out hidden words, and takes comments from other programs', async () => {
    const r = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify([{ platform: 'youtube', who: 'Ana', text: 'Hello from Cebu' }, { who: 'Bot', text: 'cheap http://scam' }, { text: '' }]) })
    expect((await r.json()).added).toBe(2)
    let s = await st()
    expect(s.chat.list.map((c: { who: string }) => c.who)).toEqual(['Ana'])
    await doit({ action: 'chat.show', id: s.chat.list[0].id })
    s = await st()
    expect(s.chat.shown).toMatchObject({ who: 'Ana', platform: 'youtube', text: 'Hello from Cebu' })
    await doit({ action: 'chat.hide' })
    expect((await st()).chat.shown).toBeNull()
  })

  it('lets a phone remote in only with the QR code’s key and once it is allowed', async () => {
    const qr = await (await fetch(`${base}/api/remote/qr`)).json()
    expect(qr.link).toMatch(/\/remote\?k=/)
    expect(qr.svg).toContain('<svg')
    const k = new URL(qr.link).searchParams.get('k')
    const hello = (key: string) => fetch(`${base}/api/remote/hello`, { method: 'POST', body: JSON.stringify({ k: key, id: 'phone-123456', name: 'Android phone' }) }).then((x) => x.json())
    const remote = (body: object) => fetch(`${base}/api/remote/do`, { method: 'POST', body: JSON.stringify({ k, id: 'phone-123456', do: body }) })
    expect((await hello('wrong')).state).toBe('badkey')
    expect((await hello(k!)).state).toBe('waiting')
    expect((await st()).remotes.pending).toEqual([{ id: 'phone-123456', name: 'Android phone' }])
    expect((await remote({ action: 'take' })).status).toBe(403)
    await doit({ action: 'remote.allow', id: 'phone-123456' })
    expect((await hello(k!)).state).toBe('allowed')
    expect((await remote({ action: 'take' })).status).toBe(200)
    expect((await st()).onAir).toMatchObject({ id: 'item-1' })
    // Only the operator's buttons: not projects or files.
    expect((await remote({ action: 'project.delete', file: 'x.gfx.json' })).status).toBe(400)
    expect((await fetch(`${base}/remote`)).status).toBe(200)
  })
})
