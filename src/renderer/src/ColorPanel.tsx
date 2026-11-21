import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/state'
import { CURVE_CHANNELS, GRADE_LIMITS, NEUTRAL_GRADE, STRAIGHT, cleanGrade, curveAt, isNeutral, isStraight, type ColorGrade, type CurveChannel, type CurvePoints, type Curves, type GradeKey } from '../../shared/color'
import type { Run } from './useApp'

type Key = GradeKey

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
      // Beside the Live monitor (over the side panel), so the whole Live picture stays in view while adjusting.
      const live = anchor.current?.closest('.monitor')?.getBoundingClientRect()
      if (live && live.right + 12 + w <= window.innerWidth - 8) {
        const top = Math.max(8, live.top)
        setAt({ left: live.right + 12, top, maxHeight: window.innerHeight - top - 8 })
        return
      }
      // Narrow window: under the Live picture instead.
      const below = live ? live.bottom + 8 : r.bottom + 6
      const left = Math.max(8, Math.min((live?.right ?? r.right) - w, window.innerWidth - w - 8))
      setAt({ left, top: below, maxHeight: Math.max(200, window.innerHeight - below - 8) })
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
        title="Exposure, white balance, contrast, saturation and curves of the picture that goes out"
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
          <span className="small muted">Changes Live, the stream and recordings (and Preview, so the next scene matches). Graphics in the Overlay keep their own colors. Double-click a slider to put it back; curves are at the bottom.</span>
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
          <CurveEditor curves={g.curves} run={run} />
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

const CURVE_TABS: Record<CurveChannel, { label: string; color: string }> = {
  all: { label: 'All', color: '#e5e7eb' },
  r: { label: 'Red', color: '#f87171' },
  g: { label: 'Green', color: '#4ade80' },
  b: { label: 'Blue', color: '#60a5fa' }
}
const BOX = 256
const pathOf = (p: CurvePoints) => {
  let d = ''
  for (let i = 0; i <= 64; i++) {
    const x = i / 64
    d += `${i ? 'L' : 'M'}${(x * BOX).toFixed(1)},${((1 - curveAt(p, x)) * BOX).toFixed(1)}`
  }
  return d
}

/**
 * Tone curves, like in photo and video editors: one for all colors and one each
 * for red, green and blue. Click the box to add a point, drag a point to move
 * it, double-click a point to take it away.
 */
function CurveEditor({ curves, run }: { curves: Curves | undefined; run: Run }) {
  const [ch, setCh] = useState<CurveChannel>('all')
  // While dragging, the curve follows the hand; the app's answer comes a moment later.
  const [local, setLocal] = useState<Curves>({})
  const dragging = useRef<{ ch: CurveChannel; i: number } | null>(null)
  const pending = useRef<Partial<Record<CurveChannel, CurvePoints | null>>>({})
  const timer = useRef<number | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const pts = (c: CurveChannel): CurvePoints => local[c] ?? curves?.[c] ?? STRAIGHT
  useEffect(() => {
    if (!dragging.current && !timer.current) setLocal({})
  }, [curves])
  useEffect(() => () => void (timer.current !== null && clearTimeout(timer.current)), [])

  const send = (c: CurveChannel, p: CurvePoints | null) => {
    setLocal((l) => ({ ...l, [c]: p ?? STRAIGHT }))
    pending.current[c] = p && !isStraight(p) ? p : null
    if (timer.current !== null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      const out = pending.current
      pending.current = {}
      void run('color.set', { curves: out })
    }, 50)
  }
  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect()
    const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
    return [clamp((e.clientX - r.left) / r.width), clamp(1 - (e.clientY - r.top) / r.height)]
  }
  const nearest = (p: CurvePoints, x: number, y: number) => {
    let best = -1
    let dist = 0.06
    p.forEach(([px, py], i) => {
      const d = Math.hypot(px - x, py - y)
      if (d < dist) {
        dist = d
        best = i
      }
    })
    return best
  }
  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    const [x, y] = at(e)
    const p = pts(ch).map((q) => [...q] as [number, number])
    let i = nearest(p, x, y)
    if (i < 0) {
      if (p.length >= 12) return
      i = p.findIndex(([px]) => px > x)
      if (i <= 0) return
      p.splice(i, 0, [x, y])
      send(ch, p)
    }
    dragging.current = { ch, i }
    svg.current?.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragging.current
    if (!d) return
    const [x, y] = at(e)
    const p = pts(d.ch).map((q) => [...q] as [number, number])
    const last = p.length - 1
    // The two ends only go up and down; a middle point stays between its neighbours.
    const nx = d.i === 0 ? 0 : d.i === last ? 1 : Math.min(p[d.i + 1][0] - 0.02, Math.max(p[d.i - 1][0] + 0.02, x))
    p[d.i] = [nx, y]
    send(d.ch, p)
  }
  const up = () => {
    dragging.current = null
  }
  const dbl = (e: React.MouseEvent<SVGSVGElement>) => {
    const [x, y] = at(e)
    const p = pts(ch)
    const i = nearest(p, x, y)
    if (i > 0 && i < p.length - 1) send(ch, p.filter((_, k) => k !== i))
  }
  const cur = pts(ch)
  const color = CURVE_TABS[ch].color
  const anyBent = CURVE_CHANNELS.some((c) => !isStraight(pts(c)))
  return (
    <div className="curves">
      <div className="color-row-head small">
        <span>Curves</span>
        <span className={anyBent ? 'color-val on' : 'color-val'}>{anyBent ? 'Adjusted' : 'Straight'}</span>
      </div>
      <div className="curve-tabs" role="tablist" aria-label="Which curve">
        {CURVE_CHANNELS.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={c === ch}
            className={`small ${c === ch ? 'on' : 'ghost'}`}
            onClick={() => setCh(c)}
            style={{ ['--dot' as string]: CURVE_TABS[c].color }}
          >
            <i className="curve-dot" />
            {CURVE_TABS[c].label}
            {!isStraight(pts(c)) && ' •'}
          </button>
        ))}
      </div>
      <svg
        ref={svg}
        className="curve-box"
        viewBox={`-6 -6 ${BOX + 12} ${BOX + 12}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={dbl}
        role="img"
        aria-label={`${CURVE_TABS[ch].label} curve`}
      >
        <defs>
          <linearGradient id="curve-shade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#000" />
            <stop offset="1" stopColor={ch === 'all' ? '#fff' : color} />
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={BOX} height={BOX} className="curve-bg" />
        <rect x={0} y={BOX - 6} width={BOX} height={6} fill="url(#curve-shade)" opacity={0.8} />
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t} className="curve-grid">
            <line x1={t * BOX} y1={0} x2={t * BOX} y2={BOX} />
            <line x1={0} y1={t * BOX} x2={BOX} y2={t * BOX} />
          </g>
        ))}
        <line x1={0} y1={BOX} x2={BOX} y2={0} className="curve-diag" />
        {CURVE_CHANNELS.filter((c) => c !== ch && !isStraight(pts(c))).map((c) => (
          <path key={c} d={pathOf(pts(c))} fill="none" stroke={CURVE_TABS[c].color} strokeWidth={1.5} opacity={0.35} />
        ))}
        <path d={pathOf(cur)} fill="none" stroke={color} strokeWidth={2.5} />
        {cur.map(([x, y], i) => (
          <circle key={i} cx={x * BOX} cy={(1 - y) * BOX} r={6} className="curve-pt" stroke={color} />
        ))}
      </svg>
      <div className="color-ends muted">
        <span>Shadows</span>
        <span>Midtones</span>
        <span>Highlights</span>
      </div>
      <div className="curve-foot">
        <span className="small muted">Click to add a point, drag to move, double-click to remove.</span>
        <button className="small ghost" disabled={isStraight(cur)} onClick={() => send(ch, null)} title={`Make the ${CURVE_TABS[ch].label.toLowerCase()} curve straight again`}>
          Reset curve
        </button>
      </div>
    </div>
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
