import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/state'
import { GRADE_LIMITS, NEUTRAL_GRADE, cleanGrade, isNeutral, type ColorGrade } from '../../shared/color'
import type { Run } from './useApp'

type Key = keyof ColorGrade

const CONTROLS: { key: Key; label: string; left: string; right: string; step: number; show: (v: number) => string }[] = [
  { key: 'exposure', label: 'Exposure', left: 'Darker', right: 'Brighter', step: 0.05, show: (v) => (v ? `${v > 0 ? '+' : ''}${v.toFixed(2)} stops` : 'As it comes in') },
  { key: 'temperature', label: 'White balance', left: 'Cooler (blue)', right: 'Warmer (orange)', step: 1, show: (v) => (v ? `${v > 0 ? 'Warmer' : 'Cooler'} ${Math.abs(v)}` : 'As it comes in') },
  { key: 'tint', label: 'Tint', left: 'Green', right: 'Magenta', step: 1, show: (v) => (v ? `${v > 0 ? 'Magenta' : 'Green'} ${Math.abs(v)}` : 'As it comes in') },
  { key: 'contrast', label: 'Contrast', left: 'Flatter', right: 'Punchier', step: 1, show: (v) => (v ? `${v > 0 ? '+' : ''}${v}` : 'As it comes in') },
  { key: 'saturation', label: 'Saturation', left: 'Black & white', right: 'More colorful', step: 1, show: (v) => (v ? `${v > 0 ? '+' : ''}${v}` : 'As it comes in') }
]

/**
 * The Live monitor's Color button: exposure, white balance, tint, contrast and
 * saturation for the picture that goes out, with Reset. Saved in the project.
 */
export function ColorButton({ state, run }: { state: AppState; run: Run }) {
  const [open, setOpen] = useState(false)
  const saved = cleanGrade(state.color)
  // While a slider moves, show it where the hand is (the app's answer comes a moment later).
  const [moving, setMoving] = useState<Partial<ColorGrade>>({})
  const g = { ...saved, ...moving }
  const pending = useRef<Partial<ColorGrade>>({})
  const timer = useRef<number | null>(null)
  const send = (key: Key, v: number) => {
    setMoving((m) => ({ ...m, [key]: v }))
    pending.current[key] = v
    if (timer.current !== null) return
    // At most about 20 changes a second, so a dragged slider doesn't flood the app.
    timer.current = window.setTimeout(() => {
      timer.current = null
      const p = pending.current
      pending.current = {}
      void run('color.set', p)
    }, 50)
  }
  useEffect(() => {
    // The app has the new values: show them (they may be changed by a remote too).
    setMoving((m) => {
      const keep: Partial<ColorGrade> = {}
      for (const k of Object.keys(m) as Key[]) if (pending.current[k] !== undefined) keep[k] = m[k]
      return keep
    })
  }, [state.color])
  useEffect(() => () => void (timer.current !== null && clearTimeout(timer.current)), [])

  const anchor = useRef<HTMLSpanElement>(null)
  const [at, setAt] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      const w = Math.min(320, window.innerWidth - 16)
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
      setAt({ left, top: r.bottom + 6, maxHeight: Math.max(200, window.innerHeight - r.bottom - 14) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  const changed = !isNeutral(g)
  return (
    <span className="listen color-ctl" ref={anchor}>
      <button
        className={`small ${changed ? 'color-on' : 'ghost'}`}
        aria-expanded={open}
        title="Exposure, white balance, contrast and saturation of the picture that goes out"
        onClick={() => setOpen(!open)}
      >
        <ColorIcon /> {changed ? 'Color adjusted' : 'Color'}
      </button>
      {open && (
        <div
          className="listen-pop color-pop"
          role="group"
          aria-label="Color of the picture that goes out"
          style={at ? { position: 'fixed', left: at.left, top: at.top, right: 'auto', width: Math.min(320, window.innerWidth - 16), maxHeight: at.maxHeight, overflowY: 'auto' } : undefined}
        >
          <strong>Color of the picture that goes out</strong>
          <span className="small muted">Changes Live, the stream and recordings (and Preview, so the next scene matches). Graphics in the Overlay keep their own colors. Double-click a slider to put it back.</span>
          {CONTROLS.map((c) => {
            const [lo, hi] = GRADE_LIMITS[c.key]
            const v = g[c.key]
            return (
              <label key={c.key} className="small color-row">
                <span className="color-row-head">
                  <span>{c.label}</span>
                  <span className={v ? 'color-val on' : 'color-val'}>{c.show(v)}</span>
                </span>
                <input
                  type="range"
                  className={`color-range ${c.key}`}
                  min={lo}
                  max={hi}
                  step={c.step}
                  value={v}
                  onChange={(e) => send(c.key, Number(e.target.value))}
                  onDoubleClick={() => send(c.key, 0)}
                  aria-valuetext={c.show(v)}
                />
                <span className="color-ends muted">
                  <span>{c.left}</span>
                  <span>{c.right}</span>
                </span>
              </label>
            )
          })}
          <div className="color-foot">
            <button
              className="small"
              disabled={!changed}
              onClick={() => {
                pending.current = {}
                setMoving({ ...NEUTRAL_GRADE })
                void run('color.reset')
                setTimeout(() => setMoving({}), 300)
              }}
              title="Put every control back: the picture as it comes in"
            >
              Reset
            </button>
            <button className="small strong" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </span>
  )
}

function ColorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
    </svg>
  )
}
