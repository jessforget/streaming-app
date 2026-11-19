import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
/* eslint-disable @typescript-eslint/no-require-imports */
const { startServer } = require('../gfx-app/server.cjs') as {
  startServer: (o: object) => Promise<{ port: number; close: () => void }>
}
type Found = { host: string; port: number; name: string; url: string; local: boolean }
const { test, find } = require('../desktop/gfxfind.cjs') as {
  test: (url: string) => Promise<{ result: string; name?: string }>
  find: (o: { nets?: string[]; signal: AbortSignal; onFound: (f: Found) => void; onProgress: (p: { done?: boolean }) => void }) => Promise<void>
}
/* eslint-enable @typescript-eslint/no-require-imports */

describe('finding and testing the gfx app', () => {
  let gfx: { port: number; close: () => void }
  let other: ReturnType<typeof createServer>
  let otherPort = 0
  beforeAll(async () => {
    gfx = await startServer({ port: 8767, dataDir: mkdtempSync(join(tmpdir(), 'gfxfind-')), log: () => {} })
    other = createServer((_q, r) => r.writeHead(404).end('Not found'))
    await new Promise<void>((ok) => other.listen(0, '127.0.0.1', ok))
    otherPort = (other.address() as { port: number }).port
  })
  afterAll(() => {
    gfx.close()
    other.close()
  })

  it('Test tells a gfx app, something else, and nothing apart', async () => {
    expect((await test(`127.0.0.1:${gfx.port}/live`)).result).toBe('connected')
    expect((await test(`http://127.0.0.1:${otherPort}/live`)).result).toBe('other')
    expect((await test('http://127.0.0.1:9/live')).result).toBe('unreachable')
    expect((await test('ftp://x')).result).toBe('unreachable')
  })

  it('Find lists the gfx app once, on another port too', async () => {
    const found: Found[] = []
    await find({ nets: [], signal: new AbortController().signal, onFound: (f) => found.push(f), onProgress: () => {} })
    const mine = found.filter((f) => f.port === gfx.port)
    expect(mine).toHaveLength(1)
    expect(mine[0].url).toBe(`http://127.0.0.1:${gfx.port}/live`)
    expect(mine[0].local).toBe(true)
  })
})
