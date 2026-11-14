/**
 * Pairing: a device proves it is in the room by typing (or scanning) the
 * 6-digit code shown on the streaming PC. It then gets its own key (token),
 * which it keeps and sends on every later connection. Only a hash of each key
 * is stored, so a copied settings file can't be used to connect.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Role } from '../../shared/protocol'
import type { PairedDevice } from '../../shared/state'
import type { DeviceAdmin } from '../../core/ports'

export interface StoredDevice {
  id: string
  name: string
  role: Role
  tokenHash: string
  pairedAt: number
}

export interface DeviceStore {
  load(): StoredDevice[]
  save(devices: StoredDevice[]): void
}

export class MemoryDeviceStore implements DeviceStore {
  private devices: StoredDevice[] = []
  load() {
    return [...this.devices]
  }
  save(devices: StoredDevice[]) {
    this.devices = [...devices]
  }
}

export interface PairingSnapshot {
  pairingOpen: boolean
  pairingCode: string
  list: PairedDevice[]
}

/** After this many wrong codes in a minute, the code changes. */
const MAX_FAILURES_PER_MINUTE = 10

export class PairingManager implements DeviceAdmin {
  private devices: StoredDevice[]
  private connected = new Map<string, number>()
  private code = ''
  private open: boolean
  private failures: number[] = []
  private changeListeners: ((s: PairingSnapshot) => void)[] = []
  private removeListeners: ((deviceId: string) => void)[] = []
  private roleListeners: ((deviceId: string, role: Role) => void)[] = []

  constructor(
    private readonly store: DeviceStore,
    options: { open?: boolean; now?: () => number } = {}
  ) {
    this.devices = store.load()
    this.open = options.open ?? true
    this.now = options.now ?? (() => Date.now())
    this.code = newCode()
  }

  private readonly now: () => number

  get pairingCode() {
    return this.code
  }

  onChange(fn: (s: PairingSnapshot) => void) {
    this.changeListeners.push(fn)
  }
  onRemove(fn: (deviceId: string) => void) {
    this.removeListeners.push(fn)
  }
  onRoleChange(fn: (deviceId: string, role: Role) => void) {
    this.roleListeners.push(fn)
  }

  snapshot(): PairingSnapshot {
    return {
      pairingOpen: this.open,
      pairingCode: this.open ? this.code : '',
      list: this.devices.map((d) => ({
        id: d.id,
        name: d.name,
        role: d.role,
        pairedAt: d.pairedAt,
        connected: (this.connected.get(d.id) ?? 0) > 0
      }))
    }
  }

  /** Returns the new device and its key, or throws with a plain-words reason. */
  pair(code: string, name: string, role: Role = 'remote'): { device: StoredDevice; token: string } {
    if (!this.open) throw new Error('Pairing is turned off on the streaming PC')
    if (typeof code !== 'string' || !safeEqual(code.replace(/\s/g, ''), this.code)) {
      this.recordFailure()
      throw new Error('Wrong pairing code')
    }
    const cleanName = String(name ?? '').trim().slice(0, 40) || 'Device'
    const token = randomBytes(32).toString('hex')
    const device: StoredDevice = {
      id: randomUUID(),
      name: cleanName,
      role,
      tokenHash: hash(token),
      pairedAt: this.now()
    }
    this.devices.push(device)
    this.store.save(this.devices)
    // A code works once: the next device gets a fresh one.
    this.code = newCode()
    this.publish()
    return { device, token }
  }

  authenticate(token: unknown): StoredDevice | undefined {
    if (typeof token !== 'string' || token.length !== 64) return undefined
    const h = hash(token)
    return this.devices.find((d) => safeEqual(d.tokenHash, h))
  }

  get(deviceId: string) {
    return this.devices.find((d) => d.id === deviceId)
  }

  markConnected(deviceId: string, delta: 1 | -1) {
    this.connected.set(deviceId, Math.max(0, (this.connected.get(deviceId) ?? 0) + delta))
    this.publish()
  }

  setPairingOpen(open: boolean) {
    this.open = open
    if (open) this.code = newCode()
    this.publish()
  }

  newPairingCode() {
    this.code = newCode()
    this.publish()
  }

  remove(deviceId: string) {
    this.devices = this.devices.filter((d) => d.id !== deviceId)
    this.store.save(this.devices)
    this.removeListeners.forEach((fn) => fn(deviceId))
    this.connected.delete(deviceId)
    this.publish()
  }

  setRole(deviceId: string, role: Role) {
    const d = this.devices.find((x) => x.id === deviceId)
    if (!d) throw new Error('No such device')
    d.role = role
    this.store.save(this.devices)
    this.roleListeners.forEach((fn) => fn(deviceId, role))
    this.publish()
  }

  private recordFailure() {
    const t = this.now()
    this.failures = this.failures.filter((x) => t - x < 60_000)
    this.failures.push(t)
    if (this.failures.length >= MAX_FAILURES_PER_MINUTE) {
      this.failures = []
      this.code = newCode()
      this.publish()
    }
  }

  private publish() {
    const s = this.snapshot()
    this.changeListeners.forEach((fn) => fn(s))
  }
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
