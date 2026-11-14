/**
 * Run the control server without the desktop app, with the simulated engine.
 * Handy for building the companion app or a stream deck, and for trying the
 * tablet remote.
 *
 *   npm run build            (once, so the tablet page exists)
 *   npm run server
 *   npm run server -- --port 7421
 */
import { join } from 'node:path'
import { Controller } from '../src/core/controller'
import { defaultState } from '../src/core/defaults'
import { MemoryKeyStore } from '../src/core/ports'
import { SimEngine } from '../src/core/sim'
import { ControlServer } from '../src/main/control/server'
import { MemoryDeviceStore, PairingManager } from '../src/main/control/pairing'
import { DEFAULT_CONTROL_PORT } from '../src/shared/protocol'

async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? '') : '')
  const port = Number(flag('--port')) || DEFAULT_CONTROL_PORT

  const initial = defaultState()
  const keys = new MemoryKeyStore()
  keys.set('youtube', 'practice')
  const pairing = new PairingManager(new MemoryDeviceStore())
  const controller = new Controller({ engine: new SimEngine(), keys, initial, devices: pairing })
  pairing.onChange((s) => {
    controller.updateDevices(s)
    if (s.pairingCode) console.log(`Pairing code: ${s.pairingCode}`)
  })
  controller.on('error', (m) => console.warn(m))
  await controller.start()

  const server = new ControlServer({ controller, pairing, port, staticDir: join(__dirname, '../out/renderer') })
  await server.start()
  controller.updateDevices({ ...pairing.snapshot(), controlUrl: server.urls()[0] })

  console.log('\nControl server running (practice mode, nothing is captured or sent).')
  for (const url of server.urls()) console.log(`  Tablet remote: ${url}/remote    Test page: ${url}/test`)
  console.log(`  WebSocket:     ws://<this-pc>:${server.port}/ws`)
  console.log(`Pairing code: ${pairing.pairingCode}\n`)

  const stop = async () => {
    await server.stop()
    await controller.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
