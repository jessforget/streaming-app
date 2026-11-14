import { useCallback, useEffect, useState } from 'react'
import type { AppState, HealthStats } from '../../shared/state'
import type { Action, CommandMap } from '../../shared/protocol'
import type { Bridge } from './bridge/bridge'

export type Run = <A extends Action>(action: A, params?: CommandMap[A]) => Promise<boolean>

/** Live app state for a screen, plus `run` to send commands and a notice line for errors. */
export function useApp(bridge: Bridge) {
  const [state, setState] = useState<AppState | null>(null)
  const [stats, setStats] = useState<HealthStats | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    bridge.getState().then((s) => alive && setState(s))
    const offs = [
      bridge.onState((s) => setState(s)),
      bridge.onStats((s) => setStats(s)),
      bridge.onNotice((m) => setNotice(m))
    ]
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [bridge])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  const run: Run = useCallback(
    async (action, params) => {
      const r = await bridge.command(action, params)
      if (!r.ok) setNotice(r.error ?? 'That did not work')
      return r.ok
    },
    [bridge]
  )

  return { state, stats: stats ?? state?.stats ?? null, run, notice, showNotice: setNotice, clearNotice: () => setNotice(null) }
}

/** "01:24:06" since a start time, updating every second. */
export function useElapsed(since: number | null): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!since) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [since])
  if (!since) return ''
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}
