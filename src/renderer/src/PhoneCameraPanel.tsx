/**
 * The Camera panel for a phone camera, laid out like the Z CAM's: the phone's
 * picture on the left with what's arriving (resolution, frame rate, bitrate,
 * loss, delay), and its controls on the right (front / back, exposure, white
 * balance, focus, zoom, torch, as far as that phone allows). It floats: drag
 * it by its title bar, and the app stays usable behind it.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AppState } from '../../shared/state'
import { PhoneCameraBox, PhoneFacingSwitch } from './parts'
import type { PhoneLinkStats } from './studio/phones'
import type { Studio } from './studio/studio'
import type { Run } from './useApp'

const POS_KEY = 'phone-panel-pos'

export function PhoneCameraPanel(props: { state: AppState; run: Run; studio: Studio | null; device: string; onClose: () => void }) {
  const { state, run, studio, onClose } = props
  const phones = state.inputs.video.filter((d) => d.id.startsWith('phone:'))
  const [device, setDevice] = useState(props.device)
  useEffect(() => setDevice(props.device), [props.device])
  const d = state.inputs.video.find((x) => x.id === device)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as { x?: unknown; y?: unknown } | null
      return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null
    } catch {
      return null
    }
  })
  const grab = useRef<{ dx: number; dy: number; id: number } | null>(null)
  const clamp = (x: number, y: number) => {
    const w = box.current?.offsetWidth ?? 600
    return { x: Math.min(Math.max(x, 80 - w), window.innerWidth - 80), y: Math.min(Math.max(y, 0), window.innerHeight - 48) }
  }
  const onGrab = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, select')) return
    const r = box.current!.getBoundingClientRect()
    grab.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = grab.current
    if (g && g.id === e.pointerId) setPos(clamp(e.clientX - g.dx, e.clientY - g.dy))
  }
  const onDrop = () => {
    if (!grab.current) return
    grab.current = null
    try {
      if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos))
    } catch {
      // fine
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div ref={box} className={`modal camera-modal phone-panel floating ${pos ? '' : 'centered'}`} role="dialog" aria-label="Phone camera" style={pos ? { left: pos.x, top: pos.y } : undefined}>
      <header className="modal-head camera-drag" onPointerDown={onGrab} onPointerMove={onMove} onPointerUp={onDrop} onPointerCancel={onDrop} title="Drag to move">
        <h2>Camera</h2>
        {phones.length > 1 && (
          <select value={device} onChange={(e) => setDevice(e.target.value)} aria-label="Phone to control">
            {phones.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      {!d ? (
        <div className="modal-body stack">
          <p>This phone isn’t connected. Open the camera page on the phone and press Start camera.</p>
        </div>
      ) : (
        <div className="camera-body">
          <section className="camera-picture-col">
            <PhonePicture studio={studio} device={device} facing={d.facing} />
            <p className="hint">The numbers show how the phone’s picture is arriving. Blocky or behind, with lost packets or a low frame rate: the Wi-Fi is busy (put this PC on Ethernet, the phone near the router on 5 GHz).</p>
          </section>
          <section className="camera-controls">
            <div className="camera-head">
              <div>
                <strong>{d.name.replace(/ \(phone\)$/, '')}</strong>
                <span className="muted small">Phone camera · {d.facing ? 'connected' : 'reload the camera page on the phone to control it'}</span>
              </div>
              {d.facing && <span className="pill ok">● Controlling</span>}
            </div>
            <span className="eyebrow">Camera</span>
            <PhoneFacingSwitch state={state} run={run} device={device} big />
            <span className="eyebrow">Exposure, white balance, focus</span>
            {d.facing ? <PhoneCameraBox run={run} device={device} controls={d.camera ?? []} /> : <p className="hint">Waiting for the phone…</p>}
            <p className="hint">Changes go straight to the phone; it stays on the stream. What’s here depends on the phone: Android phones in Chrome allow most, iPhones keep exposure, white balance and focus on auto.</p>
          </section>
        </div>
      )}
    </div>
  )
}

/** The app's own picture from the phone, with how it's arriving. */
function PhonePicture({ studio, device, facing }: { studio: Studio | null; device: string; facing?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [has, setHas] = useState(false)
  const [link, setLink] = useState<PhoneLinkStats | null>(null)
  useEffect(() => {
    if (!studio) return
    const update = () => {
      const s = studio.phones.stream(device)
      const v = ref.current
      if (!v) return
      if (v.srcObject !== s) {
        v.srcObject = s
        if (s) void v.play().catch(() => {})
      }
      setHas(!!s)
    }
    update()
    const off = studio.phones.subscribe(update)
    let alive = true
    const tick = () => void studio.phones.linkStats(device).then((st) => alive && setLink(st)).catch(() => {})
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => {
      alive = false
      off()
      window.clearInterval(timer)
      if (ref.current) ref.current.srcObject = null
    }
  }, [studio, device])
  // Packets lost, or the frame rate falling well under 30: the Wi-Fi can't keep up. (A still, simple picture needs few Mbps, so Mbps alone says little.)
  const busy = !!link && (link.lossPct >= 2 || (link.fps > 0 && link.fps < 15))
  return (
    <div className="camera-picture">
      <video ref={ref} muted playsInline autoPlay />
      {!has && <div className="camera-nopic muted">{studio ? 'Waiting for the phone’s picture…' : 'The picture shows on the main window of the streaming PC.'}</div>}
      {link && (
        <div className="camera-info">
          <Info label="Picture" value={link.width ? `${link.width}×${link.height}` : ''} />
          <Info label="Frame rate" value={link.fps ? `${link.fps} fps` : ''} />
          <Info label="Bitrate" value={`${link.mbps.toFixed(1)} Mbps`} />
          <Info label="Lost" value={`${link.lossPct}%`} />
          <Info label="Delay" value={link.delayMs ? `${link.delayMs} ms` : ''} />
          <Info label="Codec" value={link.codec} />
          <Info label="Camera" value={facing === 'user' ? 'Front' : facing === 'environment' ? 'Back' : ''} />
        </div>
      )}
      {link && <span className={`camera-tag left ${busy ? 'rec' : ''}`}>{busy ? 'Wi-Fi busy' : 'Good connection'}</span>}
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <span>{label}</span>
      {value}
    </div>
  )
}
