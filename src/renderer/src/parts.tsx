/** Pieces shared by the main window and the tablet remote. */
import { useEffect, useRef, useState } from 'react'
import type { AppState, HealthStats, PhoneCamControl, PhoneCamValue, Scene } from '../../shared/state'
import { renderTemplate } from '../../shared/template'
import type { Run } from './useApp'

export function HealthPill({ stats }: { stats: HealthStats | null }) {
  const h = stats?.health ?? 'idle'
  return (
    <span className={`pill health-${h}`} role="status" title={stats?.message}>
      <span className="dot" />
      {stats?.message ?? 'Ready'}
    </span>
  )
}

/** A drawing of a scene: what viewers would see. Used for scene thumbnails, the tablet and the mockup; the main window shows the real video. */
export function ScenePicture({ scene, state, live, next }: { scene: Scene; state: AppState; live?: boolean; next?: boolean }) {
  const visible = scene.layers.filter((l) => l.visible)
  const video = visible.find((l) => l.kind === 'video')
  const texts = visible.filter((l) => l.kind === 'text' && l.text)
  const title = texts.find((l) => l.id.endsWith('-title'))
  const lower = texts.find((l) => l.id.endsWith('lower-third'))
  const score = texts.find((l) => l.id.endsWith('score'))
  return (
    <div className={`picture ${live ? 'is-live' : ''} ${next ? 'is-next' : ''} ${video ? 'has-camera' : ''}`}>
      {video && (
        <div className={`picture-camera ${title ? 'corner' : ''}`}>{deviceName(state, video.device) ?? video.name}</div>
      )}
      {title && <div className="picture-title">{renderTemplate(title.text!, state.data)}</div>}
      {score && <div className="picture-score">{renderTemplate(score.text!, state.data)}</div>}
      {lower && renderTemplate(lower.text!, state.data).trim() && (
        <div className="picture-lower">{renderTemplate(lower.text!, state.data)}</div>
      )}
    </div>
  )
}

/** The name of a capture or audio device, or undefined when the PC can't see it right now. */
export function deviceName(state: AppState, id: string | undefined) {
  if (!id) return undefined
  return [...state.inputs.video, ...state.inputs.audio].find((d) => d.id === id)?.name
}

export function Notice({ text, onClose }: { text: string | null; onClose: () => void }) {
  if (!text) return null
  return (
    <div className="notice" role="alert">
      <span>{text}</span>
      <button className="ghost" onClick={onClose} aria-label="Dismiss">
        ✕
      </button>
    </div>
  )
}

/**
 * A phone camera's Front / Back switch (the phone flips without dropping off the stream).
 * Shows nothing for other devices, or while the phone isn't connected.
 */
export function PhoneFacingSwitch({ state, run, device, big }: { state: AppState; run: Run; device: string | undefined; big?: boolean }) {
  if (!device?.startsWith('phone:')) return null
  const d = state.inputs.video.find((x) => x.id === device)
  if (!d) return null
  const want = state.phoneFlips?.[device]?.facing
  // Until the phone says, it may be an older camera page that can't be flipped from here.
  const now = d.facing
  const pick = (facing: 'user' | 'environment') => run('phone.facing', { device, facing })
  return (
    <span className={`phone-facing ${big ? 'big' : ''}`} role="group" aria-label={`${d.name}: front or back camera`} title={now ? undefined : 'Reload the camera page on the phone to flip it from here'}>
      {(['user', 'environment'] as const).map((f) => (
        <button
          key={f}
          type="button"
          className={`small ${now === f ? 'on' : ''}`}
          aria-pressed={now === f}
          disabled={!now || now === f}
          onClick={() => void pick(f)}
        >
          {f === 'user' ? 'Front' : 'Back'}
          {want === f && now !== f ? '…' : ''}
        </button>
      ))}
    </span>
  )
}

/** A phone camera's value, as people read it (shutter as 1/x s, ISO, K, m, zoom). */
function camFmt(d: PhoneCamControl, v: number) {
  if (d.fmt === 'shutter') {
    const s = v / 10000 // the browser counts in 100-microsecond steps
    return s >= 0.3 ? `${Math.round(s * 10) / 10} s` : `1/${Math.round(1 / s)}`
  }
  const r = d.step && d.step >= 1 ? Math.round(v) : Math.round(v * 100) / 100
  return d.unit ? (d.unit === 'x' ? `${r}x` : `${r} ${d.unit}`) : String(r)
}
// Log settings (shutter, ISO) move in ratios over 1000 slider steps; the rest use the camera's own steps.
const toPos = (d: PhoneCamControl, v: number) => {
  const min = d.min ?? 0
  const max = d.max ?? 1
  return d.scale === 'log' ? Math.round((1000 * Math.log(v / min)) / Math.log(max / min)) : v
}
const fromPos = (d: PhoneCamControl, p: number) => {
  const min = d.min ?? 0
  const max = d.max ?? 1
  let v = d.scale === 'log' ? min * Math.pow(max / min, p / 1000) : p
  if (d.step && d.scale === 'log') v = min + Math.round((v - min) / d.step) * d.step
  return Math.min(max, Math.max(min, v))
}
const rangeOf = (d: PhoneCamControl) => (d.scale === 'log' ? { min: 0, max: 1000, step: 1 } : { min: d.min, max: d.max, step: d.step || 'any' })

/**
 * A phone camera's settings (manual exposure, white balance, focus, zoom, torch), as far as that
 * phone allows. Changes go to the phone over the network; it stays on the stream.
 */
export function PhoneCameraSettings({ state, run, device, big }: { state: AppState; run: Run; device: string | undefined; big?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!device?.startsWith('phone:')) return null
  const d = state.inputs.video.find((x) => x.id === device)
  if (!d) return null
  return (
    <div className={`phone-cam ${big ? 'big' : ''}`}>
      <button type="button" className="ghost small" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!d.facing}>
        {open ? 'Hide camera settings' : 'Camera settings'}
      </button>
      {open && <PhoneCameraBox run={run} device={device} controls={d.camera ?? []} />}
    </div>
  )
}

function PhoneCameraBox({ run, device, controls }: { run: Run; device: string; controls: PhoneCamControl[] }) {
  // While a slider moves: its own value here, and the phone told a few times a second.
  const [moving, setMoving] = useState<Record<string, number>>({})
  const pending = useRef<Record<string, PhoneCamValue>>({})
  const timer = useRef<number | null>(null)
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), [])
  const send = (set: Record<string, PhoneCamValue>, now = false) => {
    Object.assign(pending.current, set)
    const go = () => {
      timer.current = null
      const all = pending.current
      pending.current = {}
      if (Object.keys(all).length) void run('phone.camera', { device, set: all })
    }
    if (now) {
      if (timer.current) window.clearTimeout(timer.current)
      go()
    } else if (!timer.current) timer.current = window.setTimeout(go, 120)
  }
  if (controls.length === 0) {
    return <p className="muted small phone-cam-box">This phone doesn’t let its camera settings be changed (iPhones keep exposure, white balance and focus on auto). Android phones in Chrome usually can.</p>
  }
  const val = (k: string) => controls.find((c) => c.key === k)?.value
  return (
    <div className="phone-cam-box">
      {controls
        .filter((c) => !c.show || val(c.show[0]) === c.show[1])
        .map((c) => {
          if (c.type === 'mode' || c.type === 'bool') {
            const opts: PhoneCamValue[] = c.type === 'mode' ? (c.options ?? ['auto', 'manual']) : [false, true]
            return (
              <div key={c.key} className="pc-row">
                <span className="pc-label">{c.label}</span>
                <span className="phone-facing" role="group" aria-label={c.label}>
                  {opts.map((o) => (
                    <button key={String(o)} type="button" className={`small ${c.value === o ? 'on' : ''}`} aria-pressed={c.value === o} onClick={() => send({ [c.key]: o }, true)}>
                      {o === 'auto' ? 'Auto' : o === 'manual' ? 'Manual' : o ? 'On' : 'Off'}
                    </button>
                  ))}
                </span>
              </div>
            )
          }
          const v = moving[c.key] ?? (typeof c.value === 'number' ? c.value : (c.min ?? 0))
          return (
            <label key={c.key} className="pc-row pc-range">
              <span className="pc-label">
                {c.label} <span className="muted">{camFmt(c, v)}</span>
              </span>
              <input
                type="range"
                {...rangeOf(c)}
                value={toPos(c, v)}
                aria-label={c.label}
                onChange={(e) => {
                  const nv = fromPos(c, Number(e.target.value))
                  setMoving((m) => ({ ...m, [c.key]: nv }))
                  send({ [c.key]: nv })
                }}
                onPointerUp={() => {
                  send({}, true)
                  setMoving((m) => {
                    const { [c.key]: _drop, ...rest } = m
                    return rest
                  })
                }}
                onKeyUp={() => send({}, true)}
              />
            </label>
          )
        })}
    </div>
  )
}
