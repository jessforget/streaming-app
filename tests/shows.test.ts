import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore, MemoryShowStore } from '../src/core/ports'
import { isShowFileName, readShow, showFileName } from '../src/core/show'
import { SimEngine } from '../src/core/sim'
import { SetupFile, ShowFolder } from '../src/server/storage'

async function setup(shows = new MemoryShowStore()) {
  const engine = new SimEngine()
  const keys = new MemoryKeyStore()
  keys.set('youtube', 'secret-key-123')
  const c = new Controller({ engine, keys, initial: defaultState(), shows, now: () => 5000 })
  await c.start({ statsIntervalMs: 0, devicePollMs: 0 })
  return { engine, keys, c, shows }
}

describe('show files', () => {
  it('saves the layout, notices changes, and opens it again', async () => {
    const { c, shows } = await setup()
    expect(c.state.show.changed).toBe(false)
    await c.run('local', 'show.save', { name: 'Sunday service' })
    expect(c.state.setupName).toBe('Sunday service')
    expect(c.state.show).toEqual({ file: 'Sunday service.show.json', savedAt: 5000, changed: false })

    await c.run('local', 'scene.rename', { sceneId: 'live', name: 'Sermon' })
    await c.run('local', 'data.set', { values: { 'guest.name': 'Pastor Kim' } })
    expect(c.state.show.changed).toBe(true)

    // Live data values alone don't count as a change to the layout.
    await c.run('local', 'show.save')
    await c.run('local', 'data.set', { values: { 'guest.name': 'Someone else' } })
    expect(c.state.show.changed).toBe(false)

    await c.run('local', 'scene.add', { name: 'Extra' })
    await c.run('local', 'show.open', { file: 'Sunday service.show.json' })
    expect(c.state.scenes.find((s) => s.id === 'live')?.name).toBe('Sermon')
    expect(c.state.scenes.some((s) => s.name === 'Extra')).toBe(false)
    expect(c.state.data['guest.name'].value).toBe('Pastor Kim')
    expect(c.state.show.changed).toBe(false)
    expect(c.state.scenes.some((s) => s.id === 'overlay')).toBe(true)

    const list = (await c.run('local', 'show.list')) as { shows: { file: string; name: string }[] }
    expect(list.shows.map((s) => s.name)).toEqual(['Sunday service'])
    expect(JSON.stringify(shows.read('Sunday service.show.json'))).not.toContain('secret-key-123')
  })

  it('Save as makes a second show; New starts fresh and keeps the stream keys', async () => {
    const { c, keys } = await setup()
    await c.run('local', 'show.save', { name: 'Game night' })
    await c.run('local', 'show.save', { name: 'Game night (finals)' })
    const list = (await c.run('local', 'show.list')) as { shows: unknown[] }
    expect(list.shows).toHaveLength(2)
    await c.run('local', 'show.new', { name: 'Podcast' })
    expect(c.state.setupName).toBe('Podcast')
    expect(c.state.show).toEqual({ file: null, savedAt: null, changed: true })
    expect(keys.get('youtube')).toBe('secret-key-123')
    expect(c.state.stream.destinations.find((d) => d.id === 'youtube')?.hasKey).toBe(true)
  })

  it('will not open a show while streaming or recording', async () => {
    const { c } = await setup()
    await c.run('local', 'show.save', { name: 'A' })
    await c.run('local', 'record.start')
    await expect(c.run('local', 'show.open', { file: 'A.show.json' })).rejects.toThrow('Stop streaming and recording first')
  })

  it('only the PC itself can save or open shows', async () => {
    const { c } = await setup()
    await expect(c.run('remote', 'show.save', { name: 'x' })).rejects.toThrow('Not allowed')
  })

  it('imports a show file from another PC and finds its devices by name', async () => {
    const a = await setup()
    a.c.state.inputs.video.push({ id: 'old-pc-atem', name: 'Blackmagic Design ATEM Mini' })
    await a.c.run('local', 'layer.update', { sceneId: 'live', layerId: 'live-atem', device: 'old-pc-atem' })
    const file = await a.c.run('local', 'show.export')

    const b = await setup()
    b.c.state.inputs.video.push({ id: 'new-pc-atem', name: 'Blackmagic Design ATEM Mini' })
    await b.c.run('local', 'show.import', { show: JSON.parse(JSON.stringify(file)) })
    const atem = b.c.state.scenes.find((s) => s.id === 'live')?.layers.find((l) => l.id === 'live-atem')
    expect(atem?.device).toBe('new-pc-atem')
    expect(b.c.state.show.file).toBe('My show.show.json')
    await b.c.run('local', 'show.import', { show: file })
    expect(b.c.state.show.file).toBe('My show (2).show.json')
    await expect(b.c.run('local', 'show.import', { show: { hello: 1 } })).rejects.toThrow('isn’t a project file')
  })

  it('leaves the gfx commercial scene out of the show', async () => {
    const { c, shows } = await setup()
    await c.run('local', 'cue.commercial', { name: 'Ad', path: '/tmp/ad.mp4' })
    await c.run('local', 'show.save', { name: 'With ad' })
    const saved = readShow(shows.read('With ad.show.json'))
    expect(saved.scenes.some((s) => s.commercial)).toBe(false)
  })
})

describe('show file names', () => {
  it('turns a show name into a safe file name', () => {
    expect(showFileName('Friday: Finals / Live?')).toBe('Friday Finals Live.show.json')
    expect(showFileName('   ')).toBe('Show.show.json')
    expect(isShowFileName('A.show.json')).toBe(true)
    expect(isShowFileName('../x.show.json')).toBe(false)
    expect(isShowFileName('C:\\x.show.json')).toBe(false)
    expect(isShowFileName('setup.json')).toBe(false)
  })
})

describe('shows folder on disk', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('writes, lists, reads and deletes show files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shows-'))
    const { c } = await setup(new ShowFolder(join(dir, 'Streaming App Shows')) as unknown as MemoryShowStore)
    await c.run('local', 'show.save', { name: 'Wedding' })
    expect(readdirSync(join(dir, 'Streaming App Shows'))).toEqual(['Wedding.show.json'])
    expect(JSON.parse(readFileSync(join(dir, 'Streaming App Shows', 'Wedding.show.json'), 'utf8')).format).toBe('streaming-app-show')
    const list = (await c.run('local', 'show.list')) as { shows: { name: string; scenes: number }[] }
    expect(list.shows[0]).toMatchObject({ name: 'Wedding', scenes: 5 })
    await c.run('local', 'show.delete', { file: 'Wedding.show.json' })
    expect(readdirSync(join(dir, 'Streaming App Shows'))).toEqual([])
    expect(c.state.show.file).toBe(null)
  })

  it('remembers the open show and its live data after a restart', () => {
    dir = mkdtempSync(join(tmpdir(), 'setup-'))
    const file = new SetupFile(join(dir, 'setup.json'))
    const s = defaultState()
    s.show = { file: 'A.show.json', savedAt: 1, changed: true }
    s.data = { 'team1.name': { value: 'Lions', updatedAt: 1, source: 'x' } }
    file.save(s)
    const back = file.load()
    expect(back.show).toEqual(s.show)
    expect(back.data['team1.name'].value).toBe('Lions')
  })
})
