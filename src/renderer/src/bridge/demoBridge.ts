/**
 * The whole app running in the browser with the simulated engine and ATEM.
 * Used by the interactive mockup: the main window and the tablet remote share
 * one controller, so pressing a button on one updates the other.
 */
import { Controller, errorText } from '../../../core/controller'
import { defaultState } from '../../../core/defaults'
import { MemoryKeyStore, type DeviceAdmin } from '../../../core/ports'
import { SimAtem, SimEngine } from '../../../core/sim'
import { CommandError, type Action, type Caller, type CommandMap, type Role } from '../../../shared/protocol'
import type { AppState, HealthStats, PairedDevice } from '../../../shared/state'
import type { Bridge, CommandResult } from './bridge'

class DemoDevices implements DeviceAdmin {
  list: PairedDevice[] = [
    { id: 'ipad', name: 'Studio iPad', role: 'remote', connected: true, pairedAt: Date.now() - 86_400_000 },
    { id: 'scoreboard', name: 'Scoreboard PC', role: 'data', connected: true, pairedAt: Date.now() - 3_600_000 },
    { id: 'phone', name: 'Producer phone', role: 'viewer', connected: false, pairedAt: Date.now() - 600_000 }
  ]
  open = true
  code = '482913'
  constructor(private readonly publish: () => void) {}
  setPairingOpen(open: boolean) {
    this.open = open
    this.publish()
  }
  newPairingCode() {
    this.code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
    this.publish()
  }
  remove(id: string) {
    this.list = this.list.filter((d) => d.id !== id)
    this.publish()
  }
  setRole(id: string, role: Role) {
    this.list = this.list.map((d) => (d.id === id ? { ...d, role } : d))
    this.publish()
  }
}

export class DemoApp {
  readonly controller: Controller
  private devices: DemoDevices

  constructor() {
    const keys = new MemoryKeyStore()
    keys.set('youtube', 'demo-key')
    const initial: AppState = defaultState()
    initial.engine = { mode: 'simulated', note: 'Mockup: nothing is captured or sent' }
    initial.setupName = 'Friday show'
    initial.atem.host = '192.168.1.240'
    initial.scenes[1].layers[2].visible = true
    const atem = new SimAtem()
    this.controller = new Controller({ engine: new SimEngine(), atem, keys, initial })
    this.devices = new DemoDevices(() =>
      this.controller.updateDevices({
        pairingOpen: this.devices.open,
        pairingCode: this.devices.open ? this.devices.code : '',
        list: this.devices.list
      })
    )
    this.controller.setDeviceAdmin(this.devices)
    this.controller.updateDevices({
      pairingOpen: true,
      pairingCode: this.devices.code,
      controlUrl: 'http://192.168.1.20:7420',
      list: this.devices.list
    })
  }

  async start() {
    await this.controller.start({ statsIntervalMs: 1000 })
    await this.controller.run(
      'local',
      'data.set',
      {
        values: { 'team1.name': 'Falcons', 'team2.name': 'Sharks', 'team1.score': 2, 'team2.score': 1, 'guest.name': 'Sam Rivera' }
      },
      'Scoreboard PC'
    )
  }

  /** A view of the app as one caller sees it (the main window, or the tablet). */
  bridge(caller: Caller, mode: Bridge['mode'] = 'demo'): Bridge {
    const c = this.controller
    return {
      mode,
      getState: async () => structuredClone(c.state),
      command: async <A extends Action>(action: A, params?: CommandMap[A]): Promise<CommandResult> => {
        try {
          const source = caller === 'local' ? 'This PC' : caller === 'data' ? 'Scoreboard PC' : 'Studio iPad'
          return { ok: true, data: await c.run(caller, action, params ?? {}, source) }
        } catch (e) {
          return { ok: false, error: e instanceof CommandError ? e.message : errorText(e) }
        }
      },
      onState: (fn: (s: AppState) => void) => c.on('state', (s) => fn(structuredClone(s))),
      onStats: (fn: (s: HealthStats) => void) => c.on('stats', (s) => fn({ ...s })),
      onNotice: (fn: (m: string) => void) => c.on('error', fn)
    }
  }
}
