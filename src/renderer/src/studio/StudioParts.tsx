/** Pieces of the main window that show the studio's live video and sound. */
import { useEffect, useReducer, useRef, useState } from 'react'
import type { AppState } from '../../../shared/state'
import type { Studio } from './studio'

/** Shows one of the studio's canvases (Live or Preview), moving the real canvas into the page. */
export function LiveCanvas({ canvas, live, next }: { canvas: HTMLCanvasElement; live?: boolean; next?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.appendChild(canvas)
    return () => canvas.remove()
  }, [canvas])
  return <div ref={ref} className={`picture live-video ${live ? 'is-live' : ''} ${next ? 'is-next' : ''}`} />
}

/**
 * A live picture of a scene on its scene card: 2 frames a second at 256x144,
 * so a row of cards costs next to nothing next to Live and Preview.
 */
export function SceneThumb({ studio, sceneId, live, next }: { studio: Studio; sceneId: string; live?: boolean; next?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const draw = () => {
      if (document.hidden || !ref.current) return
      studio.compositor.drawThumbnail(sceneId, ref.current)
    }
    draw()
    const t = setInterval(draw, 500)
    return () => clearInterval(t)
  }, [studio, sceneId])
  return <canvas ref={ref} width={256} height={144} className={`picture scene-thumb ${live ? 'is-live' : ''} ${next ? 'is-next' : ''}`} />
}

/** An audio meter that reads the mixer directly, many times a second, without redrawing the page. */
export function LiveMeter({ studio, id, horizontal }: { studio: Studio; id: string; horizontal?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let frame = 0
    let shown = 0
    const loop = () => {
      const level = studio.levels()[id] ?? 0
      // Fast up, slow down, like a real meter.
      shown = level > shown ? level : shown * 0.9
      if (ref.current) ref.current.style[horizontal ? 'width' : 'height'] = `${Math.round(Math.sqrt(shown) * 100)}%`
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [studio, id, horizontal])
  return <div ref={ref} className="meter" />
}

/**
 * The line under the top bar: things to click before they work (screen
 * capture, desktop sound), devices that would not open, and a warning when
 * another tab runs the video.
 */
export function StudioBar({ studio, elsewhere, state }: { studio: Studio | null; elsewhere: boolean; state: AppState }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    if (!studio) return
    const off = studio.subscribe(redraw)
    // Device problems show up a moment after a device is opened.
    const t = setInterval(redraw, 1500)
    return () => {
      off()
      clearInterval(t)
    }
  }, [studio])

  if (elsewhere) {
    return (
      <div className="studio-bar warn" role="status">
        The video runs in another tab or window of this app. Keep that one open; this one is for control only.
      </div>
    )
  }
  if (!studio) return null
  const waiting = studio.waiting
  const problems: Problem[] = []
  for (const [id, why] of studio.compositor.problems) {
    const dev = state.inputs.video.find((d) => d.id === id)
    if (dev) {
      problems.push({ kind: 'video', text: `${dev.name}: ${why}` })
      continue
    }
    // Not among the cameras this PC sees now (unplugged, or a camera from another PC): say where it's used.
    const uses = state.scenes.flatMap((sc) => sc.layers.filter((l) => l.device === id).map((l) => `${l.name} in ${sc.name}`))
    problems.push({ kind: 'video', text: `${uses.length ? uses.join(', ') : 'A video input'}: ${why} (that camera isn’t plugged into this PC)` })
  }
  for (const [id, why] of studio.mixer.problems) {
    const layer = state.scenes.flatMap((x) => x.layers).find((l) => `mediasound-${l.id}` === id || `gfxsound-${l.id}` === id)
    const name = state.audio.find((a) => a.id === id)?.name ?? (id === 'commercials' ? 'Commercials' : layer ? `${layer.name} (sound)` : 'An audio channel')
    if (!(id === 'desktop' || why.startsWith('Needs a click'))) problems.push({ kind: 'sound', text: `${name}: ${why}` })
  }
  const soundOff = !studio.soundOn
  if (waiting.length === 0 && problems.length === 0 && !soundOff) return null
  const allow = async (w: (typeof waiting)[number]) => {
    setBusy(w.id)
    try {
      if (w.kind === 'desktop') await studio.allowDesktopSound()
      else await studio.allowDisplay(w.id)
    } catch {
      // The person closed the browser's share box: leave the button there.
    } finally {
      setBusy(null)
    }
  }
  const asks = soundOff || waiting.length > 0
  return (
    <>
      {asks && (
        <div className="studio-bar" role="status">
          {soundOff && (
            <span className="studio-ask">
              The browser keeps sound off until you click on this page once.
              <button className="small accent" onClick={() => studio.mixer.resume()}>
                Turn on sound
              </button>
            </span>
          )}
          {waiting.map((w) => (
            <span key={w.id} className="studio-ask">
              {w.kind === 'desktop' ? 'Desktop sound needs your OK.' : `“${w.label}” needs you to pick what to share.`}
              <button className="small accent" disabled={busy === w.id} onClick={() => allow(w)}>
                {w.kind === 'desktop' ? 'Share desktop sound' : 'Pick screen or window'}
              </button>
            </span>
          ))}
        </div>
      )}
      {problems.length > 0 && <MessagesTray problems={problems} />}
    </>
  )
}

interface Problem {
  kind: 'video' | 'sound'
  text: string
}

/**
 * Messages about cameras and sound (not plugged in, no sound found…): a small button in the corner
 * with how many there are, and a pop-up with the list, instead of lines across the top of the window.
 */
function MessagesTray({ problems }: { problems: Problem[] }) {
  const [open, setOpen] = useState(false)
  // Seen = the messages that were there when the list was last opened: the button only stands out for new ones.
  const [seen, setSeen] = useState<Set<string>>(() => new Set())
  const box = useRef<HTMLDivElement>(null)
  const fresh = problems.filter((p) => !seen.has(p.text)).length
  useEffect(() => {
    if (!open) return
    setSeen(new Set(problems.map((p) => p.text)))
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, problems.map((p) => p.text).join('|')])
  const groups: { title: string; list: Problem[] }[] = [
    { title: 'Cameras and video', list: problems.filter((p) => p.kind === 'video') },
    { title: 'Sound', list: problems.filter((p) => p.kind === 'sound') }
  ].filter((g) => g.list.length)
  return (
    <div className="messages-tray" ref={box}>
      {open && (
        <div className="messages-pop" role="dialog" aria-label="Messages">
          <header>
            <strong>Messages</strong>
            <button className="ghost small" onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </header>
          <div className="messages-list">
            {groups.map((g) => (
              <section key={g.title}>
                <h3>{g.title}</h3>
                <ul>
                  {g.list.map((p) => (
                    <li key={p.text}>{p.text}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="muted small">These go away by themselves when the camera or sound is found.</p>
        </div>
      )}
      <button
        className={`messages-btn ${fresh ? 'new' : ''}`}
        aria-expanded={open}
        title={open ? 'Close the messages' : 'Messages about cameras and sound'}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">⚠</span> {problems.length} {problems.length === 1 ? 'message' : 'messages'}
      </button>
    </div>
  )
}
