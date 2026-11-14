/**
 * A screen's connection to the app's server: the same WebSocket control API
 * the companion app and a stream deck use. Handles pairing, reconnecting and
 * requests.
 *
 * - The tablet remote pairs with a code and keeps a key.
 * - The main window on the streaming PC connects as "local" (no code needed:
 *   the server checks the connection really comes from this PC). The first
 *   main window also runs the video (the studio).
 */
import type { AppState, HealthStats } from '../../../shared/state'
import type { Action, CommandMap, Role, ServerMessage } from '../../../shared/protocol'
import type { Bridge, CommandResult } from './bridge'

const TOKEN_KEY = 'streaming-app-remote-token'

export function savedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function saveToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // private mode: the tablet will need the code again next time
  }
}

export type Status = 'connecting' | 'connected' | 'offline' | 'needs-pairing'

export class WsBridge implements Bridge {
  readonly mode: 'local' | 'remote'
  private ws: WebSocket | null = null
  private state: AppState | null = null
  private pending = new Map<string, (r: CommandResult) => void>()
  private nextId = 1
  private stateFns = new Set<(s: AppState) => void>()
  private statsFns = new Set<(s: HealthStats) => void>()
  private noticeFns = new Set<(m: string) => void>()
  private statusFns = new Set<(s: Status, detail?: string) => void>()
  private retry = 0
  private stopped = false
  role: Role | 'local' | null = null
  name = ''
  /** Main window only: true when this page runs the video and sound. */
  studio = false
  private first: object | null = null

  constructor(
    private readonly url: string,
    opts: { local?: boolean } = {}
  ) {
    this.mode = opts.local ? 'local' : 'remote'
  }

  onStatus(fn: (s: Status, detail?: string) => void) {
    this.statusFns.add(fn)
    return () => this.statusFns.delete(fn)
  }

  /** Connect with the saved key. Resolves false when the tablet must pair. */
  connect() {
    if (this.mode === 'local') return this.open({ type: 'local', studio: true })
    const token = savedToken()
    if (!token) return this.setStatus('needs-pairing')
    this.open({ type: 'hello', token })
  }

  pair(code: string, name: string) {
    this.open({ type: 'pair', code, name, role: 'remote' })
  }

  forget() {
    saveToken(null)
    this.stopped = true
    this.ws?.close()
    this.setStatus('needs-pairing')
  }

  private open(first: object) {
    this.stopped = false
    this.first = first
    this.ws?.close()
    this.setStatus('connecting')
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify(first))
    ws.onmessage = (e) => this.handle(JSON.parse(String(e.data)) as ServerMessage)
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      for (const [, resolve] of this.pending) resolve({ ok: false, error: 'Connection lost' })
      this.pending.clear()
      if (this.mode === 'local') {
        // The main window never pairs: keep trying until the app's server is back.
        this.studio = false
        this.setStatus('offline', e.code === 4005 ? e.reason : undefined)
        if (e.code === 4005) return
        const delay = Math.min(5_000, 500 * 2 ** this.retry++)
        setTimeout(() => !this.stopped && this.first && this.open(this.first), delay)
        return
      }
      if (e.code === 4004 || e.code === 4003) {
        saveToken(null)
        return this.setStatus('needs-pairing', e.code === 4003 ? 'This tablet was removed on the streaming PC' : undefined)
      }
      if (this.stopped || !savedToken()) return this.setStatus('needs-pairing', e.reason || undefined)
      this.setStatus('offline')
      const delay = Math.min(10_000, 500 * 2 ** this.retry++)
      setTimeout(() => !this.stopped && this.open({ type: 'hello', token: savedToken() }), delay)
    }
  }

  private handle(m: ServerMessage) {
    switch (m.type) {
      case 'paired':
        saveToken(m.token)
        break
      case 'welcome':
        this.retry = 0
        this.role = m.role
        this.name = m.name
        this.studio = m.studio === true
        this.state = m.state
        this.setStatus('connected')
        this.stateFns.forEach((fn) => fn(m.state))
        break
      case 'event':
        if (m.name === 'state') {
          this.state = m.state
          this.stateFns.forEach((fn) => fn(m.state))
        } else if (m.name === 'notice') this.noticeFns.forEach((fn) => fn(m.message))
        else this.statsFns.forEach((fn) => fn(m.stats))
        break
      case 'result': {
        const resolve = m.id ? this.pending.get(m.id) : undefined
        if (resolve && m.id) {
          this.pending.delete(m.id)
          resolve({ ok: m.ok, data: m.data, error: m.error })
        }
        break
      }
      case 'error':
        if (!this.role && this.mode === 'remote') this.setStatus('needs-pairing', m.error)
        else if (!this.role) this.setStatus('offline', m.error)
        else this.noticeFns.forEach((fn) => fn(m.error))
        break
    }
  }

  private setStatus(s: Status, detail?: string) {
    this.statusFns.forEach((fn) => fn(s, detail))
  }

  async getState() {
    if (this.state) return this.state
    return new Promise<AppState>((resolve) => {
      const off = this.onState((s) => {
        off()
        resolve(s)
      })
    })
  }

  command<A extends Action>(action: A, params?: CommandMap[A]): Promise<CommandResult> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: 'Not connected' })
    const id = String(this.nextId++)
    ws.send(JSON.stringify({ type: 'command', id, action, params }))
    return new Promise((resolve) => this.pending.set(id, resolve))
  }

  onState(fn: (s: AppState) => void) {
    this.stateFns.add(fn)
    return () => this.stateFns.delete(fn)
  }
  onStats(fn: (s: HealthStats) => void) {
    this.statsFns.add(fn)
    return () => this.statsFns.delete(fn)
  }
  onNotice(fn: (m: string) => void) {
    this.noticeFns.add(fn)
    return () => this.noticeFns.delete(fn)
  }
}
