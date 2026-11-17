/**
 * The web version of the app: one local server that runs everything.
 *
 *   npm start                     build the pages, then run
 *   npm run serve                 run (pages already built)
 *   npm run serve -- --port 7421
 *
 * Then open http://localhost:7420 in Chrome or Edge on this PC: that page is
 * the main window and runs the cameras and sound. Tablets open the address
 * printed below, /remote. Later, a desktop wrapper (Electron) can start this
 * same server and show the same page, with no rewrite.
 */
import { homedir } from 'node:os'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Controller, errorText } from '../core/controller'
import { freshSetup } from '../core/defaults'
import { DEFAULT_CONTROL_PORT } from '../shared/protocol'
import { BrowserEngine } from './browserEngine'
import { ControlServer } from './control/server'
import { PairingManager } from './control/pairing'
import { findFfmpeg, pickEncoder } from './ffmpeg'
import { NetCamHub } from './netcams'
import { DEFAULT_RTMP_PORT, RtmpReceiver } from './rtmp'
import { PhoneHub, namedLanAddresses } from './phones'
import { DeviceFile, FileKeyStore, SetupFile, ShowFolder, files } from './storage'

import about from '../../about.json'

const VERSION = about.version

/** Where the Setup, paired devices and stream keys are kept. */
function dataDir() {
  if (process.env.STREAMING_APP_DATA) return process.env.STREAMING_APP_DATA
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Streaming App')
  return join(homedir(), '.streaming-app')
}

/** Saved shows: Documents\Streaming App Shows on Windows, easy to find and copy to another PC. */
function showsFolder(dir: string): ShowFolder {
  if (process.env.STREAMING_APP_SHOWS) return new ShowFolder(process.env.STREAMING_APP_SHOWS)
  if (process.platform === 'win32' || existsSync(join(homedir(), 'Documents'))) {
    return new ShowFolder(join(homedir(), 'Documents', 'Streaming App Shows'), process.platform === 'win32' ? 'Documents\\Streaming App Shows' : '~/Documents/Streaming App Shows')
  }
  return new ShowFolder(join(dir, 'shows'))
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? '') : '')
  const port = Number(flag('--port')) || Number(process.env.STREAMING_CONTROL_PORT) || DEFAULT_CONTROL_PORT

  const dir = dataDir()
  const f = files(dir)
  const setup = new SetupFile(f.setup, freshSetup)
  const initial = setup.load()
  initial.engine = { mode: 'live', note: 'Video runs in the main window' }

  const ffmpeg = findFfmpeg()
  const encoder = ffmpeg ? pickEncoder(ffmpeg) : 'none'
  const engine = new BrowserEngine(ffmpeg, encoder)
  const keys = new FileKeyStore(f.keys)
  const pairing = new PairingManager(new DeviceFile(f.devices))
  const shows = showsFolder(dir)
  const controller = new Controller({ engine, keys, initial, devices: pairing, shows })
  pairing.onChange((s) => controller.updateDevices(s))
  // Problems also go to app.log in the data folder, so they can be read after the window is closed.
  const logFile = join(dir, 'app.log')
  const log = (line: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // the log is a convenience; never stop the show over it
    }
  }
  engine.onLog = log
  controller.on('error', (m) => {
    console.warn(`! ${m}`)
    log(`! ${m}`)
  })
  let wasLive = false
  let wasRec = false
  controller.on('state', (s) => {
    if (s.stream.live !== wasLive) log(s.stream.live ? 'stream started' : 'stream stopped')
    if (s.recording.active !== wasRec) log(s.recording.active ? 'recording started' : 'recording stopped')
    wasLive = s.stream.live
    wasRec = s.recording.active
  })
  log(`app started, version ${VERSION}`)
  // The studio page reports devices as they come and go, so no polling here.
  await controller.start({ devicePollMs: 0 })

  // Phones as cameras: their own HTTPS address, because phones only open the camera on HTTPS pages.
  const phones = new PhoneHub({ dataDir: dir, port: port + 1, log, staticDir: join(__dirname, '../../out/web') })
  let phonesOn = true
  try {
    await phones.start()
  } catch (e) {
    phonesOn = false
    console.warn(`Phone cameras are off: could not open port ${port + 1} (${errorText(e)}).`)
    log(`phone cameras off: ${errorText(e)}`)
  }

  // Cameras that stream to the app (RTMP, any brand): one address for all, each shows up by itself.
  const rtmp = new RtmpReceiver({ port: Number(process.env.STREAMING_RTMP_PORT) || DEFAULT_RTMP_PORT, host: process.env.STREAMING_RTMP_HOST || '0.0.0.0', log })
  let rtmpOn = true
  try {
    await rtmp.start()
  } catch (e) {
    rtmpOn = false
    console.warn(`Cameras can't stream to the app: port ${rtmp.port} is in use (${errorText(e)}).`)
    log(`camera receiver off: ${errorText(e)}`)
  }
  // Network cameras: ffmpeg reads a Z CAM E2's stream; streaming cameras come through the receiver.
  const netcams = new NetCamHub(join(dir, 'netcams.json'), ffmpeg, log, rtmpOn ? rtmp : null)

  const server = new ControlServer({
    phones: phonesOn ? phones : undefined,
    netcams,
    rtmpPort: rtmpOn ? rtmp.port : 0,
    controller,
    pairing,
    port,
    staticDir: join(__dirname, '../../out/web'),
    appVersion: VERSION,
    onMedia: (socket, kind, codec) => engine.handleMedia(socket, kind, codec),
    onStudio: (present) => engine.setStudio(present)
  })
  try {
    await server.start()
  } catch (e) {
    console.error(`Could not start on port ${port}: ${errorText(e)}. Is the app already running?`)
    process.exit(1)
  }
  controller.updateDevices({ ...pairing.snapshot(), controlUrl: server.urls()[0] })
  // Where other computers reach this PC (Settings, About). Checked again now and then: Wi-Fi can change.
  let lastNet = ''
  const updateNetwork = () => {
    const network = {
      addresses: namedLanAddresses(),
      controlPort: server.port,
      phonePort: phonesOn ? port + 1 : 0,
      rtmpPort: rtmpOn ? rtmp.port : 0
    }
    const text = JSON.stringify(network)
    if (text === lastNet) return
    lastNet = text
    controller.updateDevices({ network, controlUrl: server.urls()[0] })
  }
  updateNetwork()
  const netTimer = setInterval(updateNetwork, 10_000)
  netTimer.unref()

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  controller.on('state', () => {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        setup.save(controller.state)
      } catch (e) {
        console.error('Could not save the setup:', errorText(e))
      }
    }, 500)
  })

  console.log(`\nStreaming App ${VERSION} is running.`)
  console.log(`  Main window (this PC, Chrome or Edge):  http://localhost:${server.port}`)
  for (const url of server.urls()) console.log(`  Tablet remote (same network):          ${url}/remote`)
  console.log(`  Companion app / stream deck:            ws://<this-pc>:${server.port}/ws   (test page: /test)`)
  if (phonesOn) console.log(`  Phone cameras (scan the QR in Settings):  ${phones.links()[0].replace(/#.*/, '')}`)
  if (rtmpOn) console.log(`  Cameras that live stream (any brand):    rtmp://${server.urls()[0].replace(/^http:\/\/|:\d+$/g, '')}:${rtmp.port}/live  (any stream key)`)
  console.log(ffmpeg ?`  Video encoder: ${encoder}` : '  ffmpeg not found: streaming and recording are off until it is installed.')
  console.log(`  Settings saved in ${dir}`)
  console.log('Press Ctrl+C to stop.\n')

  const stop = async () => {
    await controller.stop().catch(() => {})
    await server.stop().catch(() => {})
    await phones.stop().catch(() => {})
    await rtmp.stop().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
