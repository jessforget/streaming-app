import { describe, expect, it } from 'vitest'
import about from '../about.json'
import pkg from '../package.json'
import { connectRows, longDate } from '../src/renderer/src/About'
import { freshSetup } from '../src/core/defaults'

describe('About', () => {
  it('shows the developer, and one version everywhere', () => {
    expect(about.developer).toBe('Jess Limot')
    expect(about.version).toBe(pkg.version)
    expect(longDate(about.revisionDate)).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/)
    expect(longDate('2026-11-17')).toBe('17 November 2026')
  })

  it('lists the address for each way in, and leaves out parts that are off', () => {
    const s = freshSetup()
    s.devices.network = { addresses: [{ name: 'Wi-Fi', ip: '192.168.1.5' }], controlPort: 7420, phonePort: 7421, rtmpPort: 0 }
    const rows = connectRows(s).map((r) => [r.label, r.url('192.168.1.5')])
    expect(rows).toEqual([
      ['Tablet remote', 'http://192.168.1.5:7420/remote'],
      ['Companion app, stream deck', 'ws://192.168.1.5:7420/ws'],
      ['Phone cameras', 'https://192.168.1.5:7421/cam']
    ])
  })
})
