/** Pieces of the main window that show the studio's live video and sound. */
import { useEffect, useReducer, useRef, useState } from 'react'
import type { AppState } from '../../../shared/state'
import type { Studio } from './studio'

/** Shows one of the studio's canvases (Live or Preview), moving the real canvas into the page. */
export function LiveCanvas({ canvas, live }: { canvas: HTMLCanvasElement; live?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.appendChild(canvas)
    return () => canvas.remove()
  }, [canvas])
  return <div ref={ref} className={`picture live-video ${live ? 'is-live' : ''}`} />
}

/** An audio meter that reads the mixer directly, many times a second, without redrawing the page. */
export function LiveMeter({ studio, id }: { studio: Studio; id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let frame = 0
    let shown = 0
    const loop = () => {
      const level = studio.levels()[id] ?? 0
      // Fast up, slow down, like a real meter.
      shown = level > shown ? level : shown * 0.9
      if (ref.current) ref.current.style.height = `${Math.round(Math.sqrt(shown) * 100)}%`
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [studio, id])
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
  const problems: string[] = []
  for (const [id, why] of studio.compositor.problems) {
    const name = state.inputs.video.find((d) => d.id === id)?.name ?? 'A video input'
    problems.push(`${name}: ${why}`)
  }
  for (const [id, why] of studio.mixer.problems) {
    const name = state.audio.find((a) => a.id === id)?.name ?? 'An audio channel'
    if (!(id === 'desktop' || why.startsWith('Needs a click'))) problems.push(`${name}: ${why}`)
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
  return (
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
      {problems.map((p) => (
        <span key={p} className="warn-text">
          {p}
        </span>
      ))}
    </div>
  )
}
