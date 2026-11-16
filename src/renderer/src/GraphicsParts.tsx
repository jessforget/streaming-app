/**
 * The Graphics (network) source's pieces in the source list and its settings:
 * the status light, the "What it shows now" preview, and Reload.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { GRAPHICS_SIZES, type AppState, type GraphicsSize, type Layer } from '../../shared/state'
import { presetFor } from '../../shared/presets'
import { graphicsFeeds, type GraphicsFeed, type GraphicsStatus } from './studio/graphics'

/** Re-render when a graphics page's status changes. */
export function useGraphicsStatus() {
  return useSyncExternalStore(
    (fn) => graphicsFeeds.subscribe(fn),
    () => graphicsFeeds.version
  )
}

const STATUS_TEXT: Record<GraphicsStatus, string> = {
  loading: 'Connecting…',
  connected: 'Connected',
  unreachable: 'Can’t reach',
  'needs-desktop': 'Needs the desktop version'
}

/** The coloured status light with its words. */
export function GraphicsStatusPill({ status }: { status: GraphicsStatus }) {
  return (
    <span className={`gfx-status ${status}`} role="status">
      <span className="dot" aria-hidden="true" />
      {STATUS_TEXT[status]}
    </span>
  )
}

/** The address without http://, for the source list. */
export function shortAddress(url: string | undefined): string {
  return (url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

/** Status line under a graphics source's name in the source list. */
export function GraphicsDetail({ state, layer, label }: { state: AppState; layer: Layer; label: string }) {
  useGraphicsStatus()
  const status = graphicsFeeds.statusOf(layer, state)
  if (!status) return <span className="layer-text warn-text">{`${label} · no address yet`}</span>
  return (
    <span className="layer-text gfx-line">
      <GraphicsStatusPill status={status} />
      <span className={status === 'unreachable' ? 'warn-text' : ''}>
        {status === 'unreachable' ? 'Showing nothing (see-through) · trying again every 5 seconds' : `${label} · ${shortAddress(layer.url)}`}
      </span>
    </span>
  )
}

/**
 * "What it shows now": opens the address (while the form is open) and shows its
 * picture over a checkerboard, so you can see what is see-through.
 */
export function GraphicsCheck(props: { state: AppState; url: string; size: string; fps: string }) {
  const { state, url, size, fps } = props
  useGraphicsStatus()
  const box = useRef<HTMLCanvasElement>(null)
  const dims = GRAPHICS_SIZES[(size as GraphicsSize) || '1080p'] ?? GRAPHICS_SIZES['1080p']
  const rate = Number(fps) || presetFor(state.stream.quality, state.stream.family).fps
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : url.trim() ? `http://${url.trim()}` : ''
  const key = `${full}|${dims.width}x${dims.height}|${rate}`
  // Wait until the typing stops before opening the address.
  const settled = useSettled(key, 700)

  useEffect(() => {
    if (!settled || !full || !graphicsFeeds.available) return
    const { close } = graphicsFeeds.check(full, dims.width, dims.height, rate, state)
    return close
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  useEffect(() => {
    let raf = 0
    let shown = -1
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const feed: GraphicsFeed | null = graphicsFeeds.feedByKey(settled ?? '')
      const c = box.current
      if (!c) return
      const version = feed && feed.ready && feed.status === 'connected' ? feed.version : -2
      if (version === shown) return
      shown = version
      const g = c.getContext('2d')!
      g.clearRect(0, 0, c.width, c.height)
      if (feed && version >= 0) g.drawImage(feed.canvas, 0, 0, c.width, c.height)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [settled])

  if (!graphicsFeeds.available) {
    return (
      <p className="gfx-note warn-text small">
        Graphics (network) sources show in the desktop version only (“Start Streaming App (desktop)”). You can add it here; it will show there.
      </p>
    )
  }
  const feed = settled ? graphicsFeeds.feedByKey(settled) : null
  const status: GraphicsStatus | null = !full ? null : feed ? feed.status : 'loading'
  return (
    <div className="gfx-check">
      <div className="gfx-check-head">
        <span className="muted small">What it shows now</span>
        {status && <GraphicsStatusPill status={status} />}
      </div>
      <div className="gfx-preview">
        <canvas ref={box} width={480} height={Math.round((480 * dims.height) / dims.width)} aria-label="Preview of the graphics page" />
        <span className="gfx-preview-tag">Checkers = see-through</span>
        {!full && <span className="gfx-preview-empty">Type the address your gfx app shows</span>}
        {status === 'unreachable' && <span className="gfx-preview-empty">Can’t reach this address. Is the gfx app running, on the same network?</span>}
      </div>
      <div>
        <button type="button" className="small" onClick={() => settled && graphicsFeeds.reloadKey(settled)} disabled={!feed}>
          Reload page
        </button>
        <small className="muted"> after you change the design in the gfx app.</small>
      </div>
    </div>
  )
}

/** The key once it has stayed the same for `ms` (null before that). */
function useSettled(key: string, ms: number): string | null {
  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setSettled(key), ms)
    return () => clearTimeout(t)
  }, [key, ms])
  return settled
}
