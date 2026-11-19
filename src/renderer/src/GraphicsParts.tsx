/**
 * The Graphics (network) source's pieces in the source list and its settings:
 * the status light, the "What it shows now" preview, and Reload.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
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

interface FoundGfx {
  name: string
  host: string
  port: number
  items: number
  local: boolean
  url: string
}
type TestResult = { result: 'connected' | 'page' | 'other' | 'unreachable'; name?: string; ms?: number; items?: number; host?: string; why?: string }
interface Finder {
  test(url: string): Promise<TestResult>
  find(onFound: (f: FoundGfx) => void, onProgress: (p: { checked: number; total: number; nets: string[]; done?: boolean }) => void): Promise<FoundGfx[]>
  stopFind(): void
  openGfxApp?: () => Promise<{ ok: boolean; url?: string; why?: string }>
}
/**
 * Start the gfx app on this PC (one operator, two monitors), or bring its window forward.
 * Resolves with its /live address once it answers, or a reason it didn't start.
 */
export async function openGfxAppHere(): Promise<{ ok: boolean; url?: string; why?: string }> {
  const f = finder()
  if (!f?.openGfxApp) return { ok: false, why: 'Only the desktop version can start the gfx app.' }
  const r: { ok: boolean; url?: string; why?: string } = await f.openGfxApp().catch((e: unknown) => ({ ok: false, why: String(e) }))
  if (!r.ok || !r.url) return r
  // It takes a few seconds to start the first time.
  for (let i = 0; i < 20; i++) {
    const t = await f.test(r.url).catch(() => null)
    if (t?.result === 'connected') return r
    await new Promise((ok) => setTimeout(ok, 500))
  }
  return { ok: false, why: 'The gfx app was started but didn’t answer yet. Give it a moment, then press Find.' }
}

export const canOpenGfxApp = () => !!finder()?.openGfxApp

const finder = (): Finder | null => {
  const d = (globalThis as { desktopGraphics?: Partial<Finder> }).desktopGraphics
  return d?.find && d.test && d.stopFind ? (d as Finder) : null
}

/**
 * The address of the graphics page, with Test, "Open the gfx app on this PC" and "Find gfx apps"
 * (the desktop version looks on this PC first, then on its network, and lists the gfx apps that answer).
 */
export function GraphicsAddress({ url, setUrl }: { url: string; setUrl: (u: string) => void }) {
  const f = finder()
  const id = useId()
  const [test, setTest] = useState<{ url: string; r: TestResult | null } | null>(null)
  const [scan, setScan] = useState<{ found: FoundGfx[]; checked: number; total: number; nets: string[]; done: boolean } | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
      finder()?.stopFind()
    },
    []
  )

  const runTest = async () => {
    if (!f || !url.trim()) return
    const at = url.trim()
    setTest({ url: at, r: null })
    const r = await f.test(at).catch((): TestResult => ({ result: 'unreachable' }))
    if (alive.current) setTest({ url: at, r })
  }
  const runFind = async () => {
    if (!f) return
    setTest(null)
    setScan({ found: [], checked: 0, total: 0, nets: [], done: false })
    const found = await f
      .find(
        (x) => alive.current && setScan((s) => (s ? { ...s, found: [...s.found, x] } : s)),
        (p) => alive.current && setScan((s) => (s ? { ...s, checked: p.checked, total: p.total, nets: p.nets } : s))
      )
      .catch(() => [] as FoundGfx[])
    if (alive.current) setScan((s) => (s ? { ...s, found: found.length ? found : s.found, done: true } : s))
  }
  const [opening, setOpening] = useState(false)
  const openHere = async () => {
    setOpening(true)
    setScan(null)
    const r = await openGfxAppHere()
    if (!alive.current) return
    setOpening(false)
    if (r.ok && r.url) {
      setUrl(r.url)
      setTest({ url: r.url, r: { result: 'connected', name: 'this PC' } })
    } else setTest({ url: url.trim(), r: { result: 'unreachable', why: r.why } })
  }
  const stop = () => {
    f?.stopFind()
    setScan((s) => (s ? { ...s, done: true } : s))
  }
  const use = (x: FoundGfx) => {
    setUrl(x.url)
    setScan(null)
    setTest({ url: x.url, r: { result: 'connected', name: x.name, items: x.items } })
  }
  const host = shortAddress(test?.url ?? url).split('/')[0]
  const shownTest = test && test.url === url.trim() ? test : null

  return (
    <div className="gfx-address">
      <label htmlFor={id}>Address of the graphics page</label>
      <div className="gfx-address-row">
        <input id={id} value={url} placeholder="http://192.168.101.50:8765/live" inputMode="url" onChange={(e) => setUrl(e.target.value)} />
        {f && (
          <button type="button" onClick={runTest} disabled={!url.trim() || (!!shownTest && !shownTest.r)}>
            {shownTest && !shownTest.r ? 'Testing…' : 'Test'}
          </button>
        )}
      </div>
      {f ? (
        <div className="gfx-find-row">
          <button type="button" className="accent strong gfx-find-btn" onClick={runFind} disabled={!!scan && !scan.done}>
            Find gfx apps (this PC and network)
          </button>
          {f.openGfxApp && (
            <button type="button" className="gfx-open-btn" onClick={openHere} disabled={opening} title="One operator, two monitors: run the gfx app on this PC too">
              {opening ? 'Opening the gfx app…' : 'Open the gfx app on this PC'}
            </button>
          )}
        </div>
      ) : (
        <small className="muted">Your gfx app shows this address. Give the gfx laptop a fixed address on the router so it never changes.</small>
      )}

      {scan && (
        <div className="gfx-scan" role="status">
          <div className="gfx-scan-head">
            {!scan.done && <span className="spinner" aria-hidden="true" />}
            <strong>
              {!scan.done
                ? `Looking on this PC${scan.nets.length ? ` and ${scan.nets.map((n) => `${n}.x`).join(', ')}` : ''}…`
                : scan.found.length
                  ? `Found ${scan.found.length} gfx app${scan.found.length === 1 ? '' : 's'}`
                  : 'No gfx app found'}
            </strong>
            {!scan.done && scan.total > 0 && <span className="muted small">{`${scan.checked} of ${scan.total} checked`}</span>}
          </div>
          {!scan.done && (
            <div className="gfx-scan-bar">
              <div style={{ width: `${scan.total ? Math.round((100 * scan.checked) / scan.total) : 0}%` }} />
            </div>
          )}
          {scan.found.length > 0 && (
            <ul className="gfx-found">
              {scan.found.map((x) => (
                <li key={x.url}>
                  <div>
                    <strong>{x.local ? 'Gfx app on this PC' : `Gfx app on ${x.name}`}</strong>
                    <span className="muted small">{`${x.host}:${x.port} · ${x.items} item${x.items === 1 ? '' : 's'} in the rundown${x.local ? ' · one operator, two monitors' : ''}`}</span>
                  </div>
                  <button type="button" className="accent strong" onClick={() => use(x)}>
                    Use this
                  </button>
                </li>
              ))}
            </ul>
          )}
          {scan.done && !scan.found.length && (
            <p className="small">
              Is the Gfx app open? On this PC, press <b>Open the gfx app on this PC</b>. On another PC, its top bar shows a <b>Let the streaming PC in</b> button when Windows Firewall is blocking it, and both PCs need to be on the same network.
            </p>
          )}
          <div className="gfx-scan-foot">
            <span className="muted small">{scan.done ? '' : 'Takes about 10 seconds. This PC first, then this network.'}</span>
            {scan.done ? (
              <button type="button" className="small" onClick={() => setScan(null)}>
                Done
              </button>
            ) : (
              <button type="button" className="small" onClick={stop}>
                Stop
              </button>
            )}
          </div>
        </div>
      )}

      {shownTest?.r && (
        <div className={`gfx-test ${shownTest.r.result}`} role="status">
          {shownTest.r.result === 'connected' && (
            <>
              <strong>Connected</strong>
              <span>{`Gfx app on ${shownTest.r.name ?? host}${shownTest.r.ms !== undefined ? ` answered in ${shownTest.r.ms} ms` : ''}. Its graphics page loads.`}</span>
            </>
          )}
          {shownTest.r.result === 'page' && (
            <>
              <strong>The page loads</strong>
              <span>It isn’t the Gfx app, but any web page can be shown.</span>
            </>
          )}
          {shownTest.r.result === 'other' && (
            <>
              <strong>Something else answered</strong>
              <span>{`${host} answered, but it isn’t the Gfx app. Another program uses that port, or the address is for another PC.`}</span>
            </>
          )}
          {shownTest.r.result === 'unreachable' && (
            <>
              <strong>{`Can’t reach ${host}`}</strong>
              <span>{shownTest.r.why ?? 'Nothing answered. Check these on the gfx PC, in this order:'}</span>
              {!shownTest.r.why && (
                <ol>
                  <li>The Gfx app is open. Its top bar shows the address to use: is it the same as here?</li>
                  <li>
                    Windows Firewall lets the Gfx app in. The Gfx app checks this itself and shows a <b>Let the streaming PC in</b> button if it’s blocked.
                  </li>
                  <li>Both PCs are on the same Wi-Fi or network (the first three numbers of the address match).</li>
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
