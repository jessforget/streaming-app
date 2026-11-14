import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PhoneHub, type PhoneOffer } from '../src/server/phones'

const dir = mkdtempSync(join(tmpdir(), 'streaming-app-phones-'))
const hub = new PhoneHub({ dataDir: dir, port: 0 })
let port = 0

function call(method: string, path: string, body?: object): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let text = ''
      res.on('data', (d) => (text += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

beforeAll(async () => {
  await hub.start()
  port = (hub as unknown as { https: import('node:https').Server }).https.address() as never
  port = (port as unknown as { port: number }).port
})
afterAll(async () => {
  await hub.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('phone cameras', () => {
  it('serves the camera page over HTTPS', async () => {
    const r = await call('GET', '/cam')
    expect(r.status).toBe(200)
    expect(r.text).toContain('Start camera')
  })

  it('puts the secret after # in the QR link', () => {
    expect(hub.links()[0]).toMatch(new RegExp(`^https://.+/cam#${hub.token}$`))
  })

  it('refuses a phone with an old QR code', async () => {
    const r = await call('POST', '/cam/offer', { t: 'wrong', id: 'abc', name: 'P', sdp: 'x' })
    expect(r.status).toBe(403)
  })

  it('asks for the main window when it is not open', async () => {
    const r = await call('POST', '/cam/offer', { t: hub.token, id: 'abc', name: 'P', sdp: 'x' })
    expect(r.status).toBe(503)
  })

  it('passes the offer to the main window and the answer back', async () => {
    const got: PhoneOffer[] = []
    hub.setStudio((o) => {
      got.push(o)
      hub.answer(o.reqId, { sdp: 'answer-sdp' })
    })
    const r = await call('POST', '/cam/offer', { t: hub.token, id: 'abc', name: 'Pixel <8>', sdp: 'offer-sdp' })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text).sdp).toBe('answer-sdp')
    expect(got[0]).toMatchObject({ id: 'abc', name: 'Pixel 8', sdp: 'offer-sdp' })
    await call('POST', '/cam/bye', { t: hub.token, id: 'abc' })
    expect(got[1]).toMatchObject({ reqId: '', id: 'abc', sdp: '' })
    hub.setStudio(null)
  })
})
