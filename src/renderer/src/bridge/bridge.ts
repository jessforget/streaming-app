import type { AppState, HealthStats } from '../../../shared/state'
import type { Action, CommandMap } from '../../../shared/protocol'

export interface CommandResult {
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * How a screen talks to the app. The main window and the tablet remote both
 * use the WebSocket control API (WsBridge); the mockup runs the whole app in
 * the browser (DemoBridge). Screens don't know which one they have.
 */
export interface Bridge {
  readonly mode: 'local' | 'remote' | 'demo'
  getState(): Promise<AppState>
  command<A extends Action>(action: A, params?: CommandMap[A]): Promise<CommandResult>
  onState(fn: (s: AppState) => void): () => void
  onStats(fn: (s: HealthStats) => void): () => void
  onNotice(fn: (msg: string) => void): () => void
}
