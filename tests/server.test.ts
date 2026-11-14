import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { ControlServer } from '../src/main/control/server'
import { MemoryDeviceStore, PairingManager } from '../src/main/control/pairing'

type Msg = Record<string, any>

class TestClient {
  ws: WebSocket
  inbox: Msg[] = []
  private waiters: { match: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = []
  closed: Promise<{ code: number; reason: string }>

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      const w = this.waiters.findIndex((x) => x.match(m))
      if (w >= 0) this.waiters.splice(w, 1)[0].resolve(m)
      else this.inbox.push(m)
    })
    this.closed = new Promise((r) => this.ws.on('close', (code, reason) => r({ code, reason: reason.toString() })))
  }
  open() {
    return new Promise<void>((r) => this.ws.once('open', () => r()))
  }
  send(m: Msg) {
    this.ws.send(JSON.stringify(m))
  }
  next(match: (m: Msg) => boolean): Promise<Msg> {
    const i = this.inbox.findIndex(match)
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0])
    return new Promise((resolve) => this.waiters.push({ match, resolve }))
  }
  async request(m: Msg) {
    const id = String(Math.random())
    this.send({ ...m, id })
    return this.next((x) => x.type === 'result' && x.id === id)
  }
}

let controller: Controller
let pairing: PairingManager
let server: ControlServer
const clients: TestClient[] = []

async function client() {
  const c = new TestClient(server.port)
  clients.push(c)
  await c.open()
  return c
}

async function pairedClient(role = 'remote') {
  const c = await client()
  c.send({ type: 'pair', code: pairing.pairingCode, name: `Test ${role}`, role })
  const paired = await c.next((m) => m.type === 'paired')
  await c.next((m) => m.type === 'welcome')
  return { c, token: paired.token as string, deviceId: paired.deviceId as string }
}

beforeEach(async () => {
  controller = new Controller({ engine: new SimEngine(), keys: new MemoryKeyStore(), initial: defaultState() })
  pairing = new PairingManager(new MemoryDeviceStore())
  controller.setDeviceAdmin(pairing)
  pairing.onChange((s) => controller.updateDevices(s))
  await controller.start({ statsIntervalMs: 0 })
  server = new ControlServer({ controller, pairing, port: 0, host: '127.0.0.1' })
  await server.start()
})

afterEach(async () => {
  clients.splice(0).forEach((c) => c.ws.terminate())
  await server.stop()
  await controller.stop()
})

describe('pairing', () => {
  it('pairs with the code, then reconnects with the key alone', async () => {
    const { c, token } = await pairedClient()
    c.ws.close()
    const again = await client()
    again.send({ type: 'hello', token })
    const welcome = await again.next((m) => m.type === 'welcome')
    expect(welcome).toMatchObject({ v: 1, name: 'Test remote', role: 'remote' })
    expect(welcome.state.scenes.length).toBe(5)
  })

  it('never sends the pairing code to devices', async () => {
    const { c } = await pairedClient()
    const r = await c.request({ type: 'command', action: 'state.get' })
    expect(r.data.devices.pairingCode).toBe('')
    expect(controller.state.devices.pairingCode).toMatch(/^\d{6}$/)
  })

  it('uses each code once', async () => {
    const code = pairing.pairingCode
    await pairedClient()
    const c = await client()
    c.send({ type: 'pair', code, name: 'Late' })
    expect(await c.next((m) => m.type === 'error')).toMatchObject({ error: 'Wrong pairing code' })
  })

  it('disconnects after too many wrong codes', async () => {
    const c = await client()
    for (let i = 0; i < 5; i++) c.send({ type: 'pair', code: 'xxxxxx', name: 'Guess' })
    expect((await c.closed).code).toBe(4002)
  })

  it('refuses commands before pairing and unknown keys', async () => {
    const c = await client()
    c.send({ type: 'command', action: 'scene.goLive' })
    expect(await c.next((m) => m.type === 'error')).toMatchObject({ error: 'Pair or say hello first' })
    c.send({ type: 'hello', token: 'f'.repeat(64) })
    expect((await c.closed).code).toBe(4004)
  })

  it('refuses pairing when it is turned off', async () => {
    await controller.run('local', 'devices.setPairingOpen', { open: false })
    const c = await client()
    c.send({ type: 'pair', code: '000000', name: 'X' })
    expect(await c.next((m) => m.type === 'error')).toMatchObject({ error: 'Pairing is turned off on the streaming PC' })
  })

  it('cuts off a removed device', async () => {
    const { c, deviceId } = await pairedClient()
    await controller.run('local', 'devices.remove', { deviceId })
    expect((await c.closed).code).toBe(4003)
  })
})

describe('commands and events', () => {
  it('runs commands and pushes the new state to every device', async () => {
    const { c: tablet } = await pairedClient('remote')
    const { c: deck } = await pairedClient('buttons')
    const r = await tablet.request({ type: 'command', action: 'scene.preview', params: { sceneId: 'brb' } })
    expect(r).toMatchObject({ ok: true })
    const ev = await deck.next((m) => m.type === 'event' && m.name === 'state' && m.state.previewSceneId === 'brb')
    expect(ev.state.devices.pairingCode).toBe('')
  })

  it('takes companion data with the short form and labels the sender', async () => {
    const { c } = await pairedClient('data')
    c.send({ type: 'data', id: 'd1', set: { 'team1.score': 2 } })
    expect(await c.next((m) => m.type === 'result' && m.id === 'd1')).toMatchObject({ ok: true })
    expect(controller.state.data['team1.score']).toMatchObject({ value: 2, source: 'Test data' })
  })

  it('answers with plain-words errors and enforces roles', async () => {
    const { c } = await pairedClient('data')
    expect(await c.request({ type: 'command', action: 'scene.goLive' })).toMatchObject({
      ok: false,
      error: 'Not allowed: "scene.goLive" needs operate permission'
    })
    expect(await c.request({ type: 'command', action: 'devices.remove', params: { deviceId: 'x' } })).toMatchObject({
      ok: false
    })
    c.send({ type: 'nonsense' })
    expect(await c.next((m) => m.type === 'error')).toMatchObject({ error: 'Unknown message type: nonsense' })
  })

  it('applies a role change straight away', async () => {
    const { c, deviceId } = await pairedClient('remote')
    await controller.run('local', 'devices.setRole', { deviceId, role: 'viewer' })
    expect(await c.request({ type: 'command', action: 'audio.muteAll' })).toMatchObject({ ok: false })
  })

  it('reports stats to devices', async () => {
    const { c } = await pairedClient('viewer')
    controller.tickStats()
    expect(await c.next((m) => m.type === 'event' && m.name === 'stats')).toMatchObject({ stats: { health: 'idle' } })
  })
})

describe('http', () => {
  it('serves info and the test page', async () => {
    const info = await fetch(`http://127.0.0.1:${server.port}/api/info`).then((r) => r.json())
    expect(info).toMatchObject({ protocol: 1, ws: '/ws' })
    const page = await fetch(`http://127.0.0.1:${server.port}/test`).then((r) => r.text())
    expect(page).toContain('Control API test page')
    expect((await fetch(`http://127.0.0.1:${server.port}/assets/../../etc/passwd`)).status).toBe(404)
  })
})
