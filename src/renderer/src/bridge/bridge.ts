import type { AppState, HealthStats } from '../../../shared/state'
import type { Action, CommandMap } from '../../../shared/protocol'

export interface CommandResult {
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * How a screen talks to the app. The main window uses Electron IPC, the
 * tablet remote uses the WebSocket control API, and the mockup runs the
 * whole app in the browser. Screens don't know which one they have.
 */
export interface Bridge {
  readonly mode: 'local' | 'remote' | 'demo'
  getState(): Promise<AppState>
  command<A extends Action>(action: A, params?: CommandMap[A]): Promise<CommandResult>
  onState(fn: (s: AppState) => void): () => void
  onStats(fn: (s: HealthStats) => void): () => void
  onNotice(fn: (msg: string) => void): () => void
}

interface PreloadApi {
  getState(): Promise<AppState>
  command(action: string, params?: unknown): Promise<CommandResult>
  onState(fn: (s: AppState) => void): () => void
  onStats(fn: (s: HealthStats) => void): () => void
  onNotice(fn: (msg: string) => void): () => void
}

declare global {
  interface Window {
    streamingApp?: PreloadApi
  }
}

export class IpcBridge implements Bridge {
  readonly mode = 'local' as const
  private api: PreloadApi
  constructor() {
    if (!window.streamingApp) throw new Error('Not running inside the desktop app')
    this.api = window.streamingApp
  }
  getState() {
    return this.api.getState()
  }
  command<A extends Action>(action: A, params?: CommandMap[A]) {
    return this.api.command(action, params)
  }
  onState(fn: (s: AppState) => void) {
    return this.api.onState(fn)
  }
  onStats(fn: (s: HealthStats) => void) {
    return this.api.onStats(fn)
  }
  onNotice(fn: (msg: string) => void) {
    return this.api.onNotice(fn)
  }
}
