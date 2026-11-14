import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { audible, scenesOnAir, type AppState, type AudioSource, type HealthStats, type Scene } from '../../shared/state'
import { PLATFORMS, QUALITY_PRESETS } from '../../shared/presets'
import type { Bridge } from './bridge/bridge'
import { AddAudioForm, AudioEditor, SceneTools, SourceList } from './Editors'
import { InstallButton } from './install'
import { HealthPill, Notice, ScenePicture } from './parts'
import { Settings, type SettingsTab } from './Settings'
import type { Studio } from './studio/studio'
import { LiveCanvas, LiveMeter, StudioBar } from './studio/StudioParts'
import { useApp, useElapsed, type Run } from './useApp'

/**
 * The main window. On the streaming PC it also runs the studio (the live
 * video and sound); in the mockup there is no studio and the monitors show a
 * drawing of each scene instead.
 */
export function MainWindow(props: { bridge: Bridge; studio?: Studio | null; studioElsewhere?: boolean }) {
  const { bridge, studio = null, studioElsewhere = false } = props
  const { state, stats, run, notice, showNotice, clearNotice } = useApp(bridge)
  const [settings, setSettings] = useState<SettingsTab | null>(null)
  useEffect(() => studio?.onNotice(showNotice), [studio, showNotice])
  if (!state) return <div className="loading">Starting…</div>
  return (
    <div className="app">
      <TopBar state={state} stats={stats} run={run} openSettings={setSettings} />
      <Notice text={notice} onClose={clearNotice} />
      <StudioBar studio={studio} elsewhere={studioElsewhere} state={state} />
      <div className="workspace">
        <main className="stage">
          <Monitors state={state} run={run} studio={studio} />
          <SceneStrip state={state} run={run} />
        </main>
        <aside className="side">
          <section className="panel">
            <SourceList state={state} run={run} scene={state.scenes.find((s) => s.id === state.previewSceneId) ?? state.scenes[0]} />
          </section>
          <SoundPanel state={state} stats={stats} run={run} studio={studio} openSettings={setSettings} />
          <section className="panel">
            <div className="panel-head">
              <h2>Live data</h2>
              <button className="ghost small" onClick={() => setSettings('devices')}>
                Devices
              </button>
            </div>
            <DataTable state={state} />
          </section>
        </aside>
      </div>
      {settings && <Settings state={state} run={run} tab={settings} onTab={setSettings} onClose={() => setSettings(null)} />}
    </div>
  )
}

/** Platforms shown as switches in the top bar: the three most used, plus any other that is on or has a key. */
const MAIN_PLATFORMS = ['youtube', 'facebook', 'instagram']

function TopBar(props: { state: AppState; stats: HealthStats | null; run: Run; openSettings: (t: SettingsTab) => void }) {
  const { state, stats, run, openSettings } = props
  const liveFor = useElapsed(state.stream.startedAt)
  const recFor = useElapsed(state.recording.startedAt)
  const live = state.stream.live
  const shown = state.stream.destinations.filter((d) => MAIN_PLATFORMS.includes(d.platform) || d.enabled || d.hasKey)
  const enabled = state.stream.destinations.filter((d) => d.enabled)
  return (
    <header className="topbar">
      <div className="setup-name">
        <strong>{state.setupName}</strong>
        <span className="muted small">
          {state.engine.mode === 'simulated' ? (
            <span className="pill practice" title={state.engine.note}>
              Practice mode
            </span>
          ) : (
            <button className="link small" onClick={() => openSettings('golive')}>
              Settings
            </button>
          )}
        </span>
      </div>
      <HealthPill stats={stats} />
      <div className="platforms" role="group" aria-label="Go live on">
        <span className="eyebrow">Go live on</span>
        {shown.map((d) => {
          const info = PLATFORMS[d.platform]
          const note = !d.hasKey ? 'add key' : d.vertical ? 'vertical' : QUALITY_PRESETS[state.stream.quality].summary.split(',')[0]
          return (
            <button
              key={d.id}
              className={`platform ${d.enabled ? 'on' : ''}`}
              aria-pressed={d.enabled}
              disabled={live}
              title={live ? 'Stop the stream to change platforms' : d.hasKey ? `Stream to ${info.label}` : `Add the ${info.label} stream key in Settings`}
              onClick={() => (d.hasKey || d.enabled ? run('settings.setDestination', { id: d.id, enabled: !d.enabled }) : openSettings('golive'))}
            >
              <span className="box" aria-hidden="true" />
              <strong>{info.label}</strong>
              <small>{note}</small>
            </button>
          )
        })}
        <button className="ghost small" onClick={() => openSettings('golive')} disabled={live}>
          More…
        </button>
      </div>
      <div className="topbar-actions">
        <InstallButton />
        <button className={`rec ${state.recording.active ? 'danger' : ''}`} onClick={() => run(state.recording.active ? 'record.stop' : 'record.start')}>
          <span className="rec-dot" aria-hidden="true" />
          {state.recording.active ? `Stop rec ${recFor}` : 'Record'}
        </button>
        {live ? (
          <button className="end-live strong" onClick={() => run('stream.stop')}>
            End stream {liveFor}
          </button>
        ) : (
          <button
            className="go-live strong"
            disabled={enabled.length === 0}
            onClick={() => run('stream.start')}
            title={enabled.length ? `Go live on ${enabled.map((d) => PLATFORMS[d.platform].label).join(', ')}` : 'Turn on a platform first'}
          >
            Go live
          </button>
        )}
      </div>
    </header>
  )
}

function Monitors({ state, run, studio }: { state: AppState; run: Run; studio: Studio | null }) {
  const preview = state.scenes.find((s) => s.id === state.previewSceneId) ?? state.scenes[0]
  const program = state.scenes.find((s) => s.id === state.programSceneId) ?? state.scenes[0]
  const liveFor = useElapsed(state.stream.startedAt)
  const onCount = state.stream.destinations.filter((d) => d.enabled).length
  const same = preview.id === program.id
  return (
    <div className="monitors-wrap">
      <div className="monitors">
        <section className="monitor preview" aria-label="Preview">
          <div className="monitor-head">
            <span className="badge next">PREVIEW</span>
            <strong>{preview.name}</strong>
          </div>
          {studio ? <LiveCanvas canvas={studio.compositor.preview} next /> : <ScenePicture scene={preview} state={state} next />}
        </section>
        <section className="monitor program" aria-label="Live">
          <div className="monitor-head">
            <span className="badge live">{state.stream.live ? 'ON AIR' : 'LIVE'}</span>
            <strong>{program.name}</strong>
            <span className="muted small push">
              {state.stream.live ? `Live ${liveFor} on ${onCount} platform${onCount === 1 ? '' : 's'}` : 'Not streaming'}
            </span>
          </div>
          {studio ? <LiveCanvas canvas={studio.compositor.program} live /> : <ScenePicture scene={program} state={state} live />}
        </section>
      </div>
      <div className="transition-bar">
        <div className="segmented wide" role="group" aria-label="Transition type">
          {(['cut', 'fade'] as const).map((k) => (
            <button key={k} className={state.transition.kind === k ? 'on' : ''} aria-pressed={state.transition.kind === k} onClick={() => run('transition.set', { kind: k })}>
              {k === 'cut' ? 'Cut' : `Fade ${state.transition.durationMs / 1000} s`}
            </button>
          ))}
        </div>
        <button className="take" onClick={() => run('scene.goLive')} disabled={same} title={same ? 'Preview and Live show the same scene' : `Put ${preview.name} on air`}>
          Transition
        </button>
      </div>
    </div>
  )
}

/**
 * Drag a scene card to change the order (mouse or touch). A short press is
 * still a click; the drag starts after the pointer moves a few pixels. While
 * dragging, the card floats under the pointer and the others slide aside to
 * show where it will land.
 */
interface SceneDrag {
  id: string
  over: number
  /** Pointer position, and where on the card it was grabbed. */
  x: number
  y: number
  dx: number
  dy: number
  w: number
  h: number
  /** Dropped: waiting for the app to save the new order. */
  dropped?: boolean
}

function useSceneDrag(run: Run, scenes: AppState['scenes'], grid: RefObject<HTMLElement | null>) {
  const [drag, setDrag] = useState<SceneDrag | null>(null)
  const start = useRef<{ id: string; x: number; y: number; pointer: number; rect: DOMRect } | null>(null)
  const moved = useRef(false)
  // Once the app has the new order, stop showing the dragged order.
  const order = scenes.map((x) => x.id).join('|')
  useEffect(() => {
    setDrag((d) => (d?.dropped ? null : d))
  }, [order])
  useEffect(() => {
    if (!drag?.dropped) return
    const t = setTimeout(() => setDrag(null), 1500)
    return () => clearTimeout(t)
  }, [drag?.dropped])
  // The slot nearest the pointer, from where the cards sit (not where they are mid-slide).
  const indexAt = (x: number, y: number) => {
    const g = grid.current
    if (!g) return null
    const box = g.getBoundingClientRect()
    let best: number | null = null
    let bestD = Infinity
    for (const card of g.querySelectorAll<HTMLElement>('[data-scene-index]')) {
      const cx = box.left + card.offsetLeft + card.offsetWidth / 2
      const cy = box.top + card.offsetTop + card.offsetHeight / 2
      const d = Math.hypot((x - cx) / card.offsetWidth, (y - cy) / card.offsetHeight)
      if (d < bestD) {
        bestD = d
        best = Number(card.dataset.sceneIndex)
      }
    }
    return best
  }
  const props = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      start.current = { id, x: e.clientX, y: e.clientY, pointer: e.pointerId, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() }
      moved.current = false
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const s = start.current
      if (!s || s.pointer !== e.pointerId) return
      if (!moved.current) {
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 8) return
        moved.current = true
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }
      const over = indexAt(e.clientX, e.clientY)
      setDrag((d) => ({
        id: s.id,
        over: over ?? d?.over ?? scenes.findIndex((x) => x.id === s.id),
        x: e.clientX,
        y: e.clientY,
        dx: s.x - s.rect.left,
        dy: s.y - s.rect.top,
        w: s.rect.width,
        h: s.rect.height
      }))
    },
    onPointerUp: () => {
      const s = start.current
      start.current = null
      if (!s || !moved.current) return
      setDrag((d) => {
        if (!d) return null
        void run('scene.move', { sceneId: s.id, index: d.over })
        return { ...d, dropped: true }
      })
    },
    onPointerCancel: () => {
      start.current = null
      moved.current = false
      setDrag(null)
    },
    // After a drag, the click that follows is not a pick.
    onClickCapture: (e: ReactMouseEvent) => {
      if (moved.current) {
        e.stopPropagation()
        e.preventDefault()
        moved.current = false
      }
    }
  })
  return { drag, props }
}

/** Cards that changed place glide to their new spot instead of jumping. */
function useSlide(container: RefObject<HTMLElement | null>, key: string) {
  const rects = useRef(new Map<string, DOMRect>())
  useLayoutEffect(() => {
    const el = container.current
    if (!el) return
    const next = new Map<string, DOMRect>()
    for (const card of el.querySelectorAll<HTMLElement>('[data-scene-id]')) {
      const id = card.dataset.sceneId!
      const now = card.getBoundingClientRect()
      next.set(id, now)
      const before = rects.current.get(id)
      if (before && (before.left !== now.left || before.top !== now.top) && !card.classList.contains('dragging')) {
        card.animate([{ transform: `translate(${before.left - now.left}px, ${before.top - now.top}px)` }, { transform: 'none' }], {
          duration: 180,
          easing: 'cubic-bezier(.2,.7,.3,1)'
        })
      }
    }
    rects.current = next
  }, [key, container])
}

function SceneCardBody({ scene, state, live, next }: { scene: Scene; state: AppState; live: boolean; next: boolean }) {
  return (
    <>
      <ScenePicture scene={scene} state={state} />
      <span className="scene-name">
        <span>{scene.name}</span>
        {live && <em className="tag live">ON AIR</em>}
        {next && <em className="tag next">PREVIEW</em>}
      </span>
    </>
  )
}

function SceneStrip({ state, run }: { state: AppState; run: Run }) {
  const preview = state.scenes.find((s) => s.id === state.previewSceneId) ?? state.scenes[0]
  const grid = useRef<HTMLDivElement>(null)
  const { drag, props } = useSceneDrag(run, state.scenes, grid)
  // While dragging, show the order it will have when dropped.
  const scenes = [...state.scenes]
  if (drag) {
    const from = scenes.findIndex((s) => s.id === drag.id)
    if (from >= 0) scenes.splice(drag.over, 0, ...scenes.splice(from, 1))
  }
  useSlide(grid, scenes.map((s) => s.id).join('|'))
  const dragged = drag && !drag.dropped ? state.scenes.find((s) => s.id === drag.id) : undefined
  const tally = (s: Scene) => ({ live: s.id === state.programSceneId, next: s.id === state.previewSceneId && s.id !== state.programSceneId })
  return (
    <section className="scenes" aria-label="Scenes">
      <div className="section-head">
        <h2>Scenes</h2>
        <span className="muted small">
          Click to put in Preview, double-click to put it on air, drag to change the order. Cameras are switched on the ATEM.
        </span>
      </div>
      <div className={`scene-grid ${dragged ? 'sorting' : ''}`} ref={grid}>
        {scenes.map((s, i) => {
          const { live, next } = tally(s)
          return (
            <button
              key={s.id}
              data-scene-index={i}
              data-scene-id={s.id}
              className={`scene-card ${live ? 'tally-live' : ''} ${next ? 'tally-next' : ''} ${dragged?.id === s.id ? 'dragging' : ''}`}
              aria-pressed={next}
              title="Drag to change the order"
              {...props(s.id)}
              onClick={() => run('scene.preview', { sceneId: s.id })}
              onDoubleClick={() => run('scene.program', { sceneId: s.id })}
            >
              <SceneCardBody scene={s} state={state} live={live} next={next} />
            </button>
          )
        })}
      </div>
      {dragged && drag && (
        <div
          className={`scene-card floating ${tally(dragged).live ? 'tally-live' : ''} ${tally(dragged).next ? 'tally-next' : ''}`}
          style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w, height: drag.h }}
          aria-hidden="true"
        >
          <SceneCardBody scene={dragged} state={state} {...tally(dragged)} />
        </div>
      )}
      <SceneTools state={state} run={run} scene={preview} />
    </section>
  )
}

function SoundPanel(props: { state: AppState; stats: HealthStats | null; run: Run; studio: Studio | null; openSettings: (t: SettingsTab) => void }) {
  const { state, stats, run, studio, openSettings } = props
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const edited = state.audio.find((a) => a.id === editing)
  return (
    <section className="panel" aria-label="Sound">
      <div className="panel-head">
        <h2>Sound</h2>
        <span className="row">
          <button className="ghost small" onClick={() => openSettings('inputs')}>
            Inputs
          </button>
          <button className="ghost small" onClick={() => run('audio.muteAll')}>
            Mute all
          </button>
          {!adding && (
            <button className="small" onClick={() => setAdding(true)}>
              + Add
            </button>
          )}
        </span>
      </div>
      {adding && <AddAudioForm state={state} run={run} onDone={() => setAdding(false)} />}
      <div className="strips">
        {state.audio.map((a) => (
          <Strip key={a.id} a={a} state={state} level={stats?.audioLevels[a.id] ?? 0} studio={studio} run={run} onEdit={() => setEditing(a.id)} />
        ))}
      </div>
      {edited && <AudioEditor key={edited.id} state={state} run={run} source={edited} onDone={() => setEditing(null)} />}
    </section>
  )
}

/** One sound channel, as a row: name, device, meter, volume, mute. */
function Strip(props: { a: AudioSource; state: AppState; level: number; studio: Studio | null; run: Run; onEdit: () => void }) {
  const { a, state, level, studio, run, onEdit } = props
  const dev = [...state.inputs.audio, ...state.inputs.video].find((d) => d.id === a.device)
  // A mic channel with no device picked uses Windows' default mic.
  const usesDefault = a.kind === 'device' && !a.device
  const unplugged = (a.kind === 'device' || a.kind === 'video') && !dev && !usesDefault
  const from =
    a.kind === 'desktop'
      ? 'This PC'
      : a.kind === 'file'
        ? `${(a.url ?? '').split(/[\\/]/).pop()}${a.loop === false ? '' : ' · loops'}`
        : usesDefault
          ? 'Windows default mic'
          : (dev?.name ?? 'Unplugged')
  // Sound follows the scene: heard only while one of its scenes is on air.
  const onAir = audible(a, scenesOnAir(state))
  const where = a.scenes
    ? a.scenes.map((id) => state.scenes.find((x) => x.id === id)?.name).filter(Boolean).join(', ')
    : 'Every scene'
  const chs = a.channels ? (a.channels.length === 1 ? `input ${a.channels[0]}` : `inputs ${a.channels.join(' + ')}`) : ''
  return (
    <div className={`strip ${a.muted ? 'muted' : ''} ${onAir ? '' : 'off-air'}`}>
      <div className="strip-head">
        <strong>{a.name}</strong>
        {onAir && a.scenes && <em className="tag live" title="Its scene is on air">ON AIR</em>}
        {a.syncOffsetMs > 0 && <span className="muted small">+{a.syncOffsetMs} ms</span>}
        <span className="strip-tools">
          <button className="ghost icon" aria-label={`Edit ${a.name}`} title="Name, device, inputs, sync offset" onClick={onEdit}>
            ✎
          </button>
          <button className="ghost icon" aria-label={`Remove ${a.name}`} title="Remove channel" onClick={() => run('audio.remove', { sourceId: a.id })}>
            ✕
          </button>
        </span>
        <button className={`small mute ${a.muted ? 'danger' : ''}`} aria-pressed={a.muted} onClick={() => run('audio.setMuted', { sourceId: a.id, muted: !a.muted })}>
          {a.muted ? 'Muted' : 'Mute'}
        </button>
      </div>
      <span className={`small ${unplugged ? 'warn-text' : 'muted'}`}>{[from, chs].filter(Boolean).join(' · ')}</span>
      <span className="small muted" title="Change in ✎">
        Plays in: {where || 'no scene'}
      </span>
      <div className="strip-level">
        <div className="hmeter">{studio ? <LiveMeter studio={studio} id={a.id} horizontal /> : <div className="meter" style={{ width: `${Math.round(level * 100)}%` }} />}</div>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(a.volume * 100)}
          aria-label={`${a.name} volume`}
          onChange={(e) => run('audio.setVolume', { sourceId: a.id, volume: Number(e.target.value) / 100 })}
        />
      </div>
    </div>
  )
}

function DataTable({ state }: { state: AppState }) {
  const rows = Object.entries(state.data).sort(([a], [b]) => a.localeCompare(b))
  if (rows.length === 0) return <p className="muted">Nothing yet. Values sent by the companion app show up here.</p>
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
          <th>From</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, f]) => (
          <tr key={k}>
            <td>
              <code>{k}</code>
            </td>
            <td>
              <strong>{String(f.value ?? '')}</strong>
            </td>
            <td className="muted">{f.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
