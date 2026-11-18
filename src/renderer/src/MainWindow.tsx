import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { BREAK_SOUND, COMMERCIALS_CHANNEL, OVERLAY_ID, audible, isOverlay, scenesOnAir, showScenes, type AppState, type AudioSource, type HealthStats, type Scene } from '../../shared/state'
import { PLATFORMS, QUALITY_PRESETS } from '../../shared/presets'
import type { Bridge } from './bridge/bridge'
import { AddAudioForm, AudioEditor, SceneTools, SourceList } from './Editors'
import { InstallButton } from './install'
import { HealthPill, Notice, ScenePicture } from './parts'
import { Settings, type SettingsTab } from './Settings'
import type { Studio } from './studio/studio'
import { LiveCanvas, LiveMeter, SceneThumb, StudioBar } from './studio/StudioParts'
import { useApp, useElapsed, type Run } from './useApp'

/**
 * The main window. On the streaming PC it also runs the studio (the live
 * video and sound); in the mockup there is no studio and the monitors show a
 * drawing of each scene instead.
 */
/** The studio, for the live pictures on the scene cards (none in the mockup or on a tablet). */
const StudioContext = createContext<Studio | null>(null)
/** Commands, for controls on scene cards (the Gfx commercial's Loop). */
const RunContext = createContext<Run | null>(null)

export function MainWindow(props: { bridge: Bridge; studio?: Studio | null; studioElsewhere?: boolean }) {
  const { bridge, studio = null, studioElsewhere = false } = props
  const { state, stats, run, notice, showNotice, clearNotice } = useApp(bridge)
  const [settings, setSettings] = useState<SettingsTab | null>(null)
  useEffect(() => studio?.onNotice(showNotice), [studio, showNotice])
  useSpaceToTransition(state, run, settings === null)
  if (!state) return <div className="loading">Starting…</div>
  return (
    <div className="app">
      <TopBar state={state} stats={stats} run={run} openSettings={setSettings} />
      <Notice text={notice} onClose={clearNotice} />
      <StudioBar studio={studio} elsewhere={studioElsewhere} state={state} />
      <div className="workspace">
        <main className="stage">
          <Monitors state={state} run={run} studio={studio} />
          <StudioContext.Provider value={studio}>
            <SceneStrip state={state} run={run} />
          </StudioContext.Provider>
        </main>
        <aside className="side">
          <section className="panel">
            <SourceList state={state} run={run} scene={state.scenes.find((s) => s.id === state.previewSceneId) ?? state.scenes[0]} />
          </section>
          {/* Sources, Sound, Overlay, Live data: the order the operator works in. */}
          <SoundPanel state={state} stats={stats} run={run} studio={studio} openSettings={setSettings} />
          <section className="panel overlay-panel">
            <SourceList state={state} run={run} scene={state.scenes.find(isOverlay) ?? { id: OVERLAY_ID, name: 'Overlay', layers: [] }} />
          </section>
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
      {settings && (
        <Settings
          state={state}
          run={run}
          tab={settings}
          onTab={setSettings}
          onClose={() => setSettings(null)}
          testKey={async (id) => {
            const r = await bridge.command('settings.testDestination', { id })
            return r.ok ? (r.data as { ok: boolean; message: string }) : { ok: false, message: r.error ?? 'Could not check the key.' }
          }}
        />
      )}
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
        <div className="transition-col" role="group" aria-label="Transition">
          <div className="segmented stacked" role="group" aria-label="Transition type">
            {(['cut', 'fade'] as const).map((k) => (
              <button
                key={k}
                className={state.transition.kind === k ? 'on' : ''}
                aria-pressed={state.transition.kind === k}
                onClick={() => run('transition.set', { kind: k })}
              >
                {k === 'cut' ? 'Cut' : `Fade ${state.transition.durationMs / 1000} s`}
              </button>
            ))}
          </div>
          <button
            className="take"
            onClick={() => run('scene.goLive')}
            disabled={same}
            title={same ? 'Preview and Live show the same scene' : `Put ${preview.name} on air (space bar)`}
          >
            Transition
          </button>
          <kbd className="key-hint" title="Press the space bar to transition">
            Space
          </kbd>
        </div>
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
    </div>
  )
}

/** Keys that type text: the space bar there is a space, not a transition. */
function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName !== 'INPUT') return false
  const type = (el as HTMLInputElement).type
  return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file', 'image'].includes(type)
}

/**
 * The space bar is the Transition button (Preview goes on air), unless you
 * are typing in a text box or Settings is open. It never clicks whatever
 * button has focus, so a scene card you just clicked isn't picked again.
 */
function useSpaceToTransition(state: AppState | null, run: Run, enabled: boolean) {
  const latest = useRef({ state, run, enabled })
  latest.current = { state, run, enabled }
  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === 'Space' || e.key === ' '
    const down = (e: KeyboardEvent) => {
      if (!isSpace(e) || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return
      const { state: s, run: go, enabled: on } = latest.current
      if (!on || !s) return
      e.preventDefault()
      if (e.repeat || s.previewSceneId === s.programSceneId) return
      void go('scene.goLive')
    }
    // Buttons click on key-up; stop that too.
    const up = (e: KeyboardEvent) => {
      if (isSpace(e) && latest.current.enabled && !typing(e.target)) e.preventDefault()
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
  }, [])
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
  /** Over the Scene library: dropping puts the scene away there. */
  toLibrary?: boolean
}

function useSceneDrag(run: Run, scenes: Scene[], all: Scene[], programId: string, grid: RefObject<HTMLElement | null>, library: RefObject<HTMLElement | null>) {
  const [drag, setDrag] = useState<SceneDrag | null>(null)
  const latest = useRef<SceneDrag | null>(null)
  latest.current = drag
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
  // Finish a drag. Also listened for on the window: when the cards slide
  // around, the browser can stop sending the pointer to the dragged card.
  const finish = () => {
    const s = start.current
    start.current = null
    const d = latest.current
    if (!s || !moved.current || !d) return
    if (d.toLibrary) {
      // The scene on air stays in the show.
      if (s.id !== programId) void run('scene.store', { sceneId: s.id, stored: true })
      setDrag(null)
      return
    }
    // The row shows only this show's scenes; the app keeps one list of all of them.
    const target = scenes[d.over]
    const index = target ? all.findIndex((x) => x.id === target.id) : all.length - 1
    void run('scene.move', { sceneId: s.id, index })
    setDrag({ ...d, dropped: true })
  }
  const follow = (e: PointerEvent | ReactPointerEvent, card?: HTMLElement) => {
    const s = start.current
    if (!s || s.pointer !== e.pointerId) return
    if (!moved.current) {
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 8) return
      moved.current = true
      card?.setPointerCapture(e.pointerId)
    }
    const over = indexAt(e.clientX, e.clientY)
    const lib = library.current?.getBoundingClientRect()
    const toLibrary = !!lib && e.clientX >= lib.left && e.clientX <= lib.right && e.clientY >= lib.top && e.clientY <= lib.bottom
    setDrag((d) => ({
      toLibrary,
      id: s.id,
      over: over ?? d?.over ?? scenes.findIndex((x) => x.id === s.id),
      x: e.clientX,
      y: e.clientY,
      dx: s.x - s.rect.left,
      dy: s.y - s.rect.top,
      w: s.rect.width,
      h: s.rect.height
    }))
  }
  useEffect(() => {
    const up = () => finish()
    const move = (e: PointerEvent) => follow(e)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointermove', move)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointermove', move)
    }
  })
  const props = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      start.current = {
        id,
        x: e.clientX,
        y: e.clientY,
        pointer: e.pointerId,
        rect: (e.currentTarget as HTMLElement).getBoundingClientRect()
      }
      moved.current = false
    },
    onPointerMove: (e: ReactPointerEvent) => follow(e, e.currentTarget as HTMLElement),
    onPointerUp: () => finish(),
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
  const studio = useContext(StudioContext)
  return (
    <>
      {studio ? <SceneThumb studio={studio} sceneId={scene.id} /> : <ScenePicture scene={scene} state={state} />}
      <span className="scene-name">
        <span>{scene.name}</span>
        {live && <em className="tag live">ON AIR</em>}
        {next && <em className="tag next">PREVIEW</em>}
      </span>
      <SceneSounds scene={scene} state={state} studio={studio} />
      {studio && <MediaClock scene={scene} studio={studio} live={live} />}
      {scene.commercial && !scene.layers.some((l) => l.kind === 'media') && <span className="media-clock empty">Nothing cued · cue videos from the gfx app</span>}
      {scene.commercial && scene.layers.some((l) => l.kind === 'media') && <LoopToggle scene={scene} />}
    </>
  )
}

/** Loop the break: play it again from the first video until this is turned off (then it ends after this round). */
function LoopToggle({ scene }: { scene: Scene }) {
  const run = useContext(RunContext)
  if (!run) return null
  const on = !!scene.breakLoop
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  return (
    // Inside the scene card (itself a button): a span that acts as a button.
    <span
      role="button"
      tabIndex={0}
      className={`loop-toggle ${on ? 'on' : ''}`}
      aria-pressed={on}
      title={on ? 'Looping: turn off to end the break after this round (with the countdown)' : 'Play the break again from the first video until this is turned off'}
      onPointerDown={stop}
      onDoubleClick={stop}
      onClick={(e) => {
        stop(e)
        run('cue.loop', { on: !on })
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          stop(e)
          run('cue.loop', { on: !on })
        }
      }}
    >
      ↻ {on ? 'Looping' : 'Loop'}
    </span>
  )
}

const clockText = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * A scene with a video that plays once (like the Gfx commercial): its length, and while it is on
 * air, the time left. A commercial break (several videos, played in order) shows which one plays
 * and the time left in the whole break. In the last 10 seconds of the last video it turns into a
 * big red countdown, so the producer can tell the show is about to start again.
 */
function MediaClock({ scene, studio, live }: { scene: Scene; studio: Studio; live: boolean }) {
  const once = scene.layers.filter((l) => l.kind === 'media' && l.loop === false && !!l.url)
  // A break: every video in it, in play order; otherwise the one shown.
  const list = scene.commercial ? once : once.filter((l) => l.visible).slice(0, 1)
  const urls = list.map((l) => l.url ?? '')
  const at = Math.max(0, list.findIndex((l) => l.visible))
  const key = urls.join('|')
  const [t, setT] = useState<{ pos: number; durs: number[] } | null>(null)
  useEffect(() => {
    if (!key) return setT(null)
    const all = key.split('|')
    const tick = () => {
      const durs = all.map((u) => {
        const d = studio.compositor.mediaElement(u)?.duration
        return d && Number.isFinite(d) ? d : 0
      })
      const pos = studio.compositor.mediaElement(all[at])?.currentTime ?? 0
      setT((old) => (old && old.durs.join() === durs.join() && Math.abs(old.pos - pos) < 0.05 ? old : { pos, durs }))
    }
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [key, at, studio])
  if (!list.length || !t || !t.durs[at]) return null
  const n = list.length
  const total = t.durs.reduce((a, b) => a + b, 0)
  const looping = !!scene.commercial && !!scene.breakLoop
  if (!live) return <span className="media-clock">{n > 1 ? `${n} commercials · ${clockText(total)}` : `Length ${clockText(t.durs[0])}`}{looping ? ' · loops' : ''}</span>
  const leftHere = Math.max(0, t.durs[at] - t.pos)
  const leftAll = leftHere + t.durs.slice(at + 1).reduce((a, b) => a + b, 0)
  const last = at === n - 1
  // A looping break doesn't end: no countdown until Loop is turned off.
  const ending = last && leftHere <= 10 && !looping
  const done = t.durs.slice(0, at).reduce((a, b) => a + b, 0) + t.pos
  return (
    <span className={`media-clock on ${ending ? 'ending' : ''}`} role="timer" aria-label={`${Math.ceil(leftAll)} seconds left`}>
      <span className="media-clock-text">
        {ending ? (
          <>
            Ends in <b>{Math.ceil(leftHere)}</b>
          </>
        ) : looping ? (
          <>{n > 1 ? `Looping · ${at + 1} of ${n}` : `Looping · ${clockText(Math.ceil(leftHere))}`}</>
        ) : n > 1 ? (
          <>
            {at + 1} of {n} · {clockText(Math.ceil(leftAll))} left
          </>
        ) : (
          <>{clockText(Math.ceil(leftHere))} left</>
        )}
      </span>
      <span className="media-clock-bar">
        <span style={{ width: `${total ? Math.min(100, (100 * done) / total) : 0}%` }} />
      </span>
      {scene.commercial && (
        <span className="media-clock-sound" title="The break’s sound on the stream (the Commercials channel in Sound)">
          <SpeakerIcon />
          <span className="hmeter">
            <LiveMeter studio={studio} id={COMMERCIALS_CHANNEL} horizontal />
          </span>
        </span>
      )}
    </span>
  )
}

function SpeakerIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  )
}

const LIBRARY_OPEN_KEY = 'scene-library-open-v2'

function SceneStrip({ state, run }: { state: AppState; run: Run }) {
  const preview = state.scenes.find((s) => s.id === state.previewSceneId) ?? state.scenes[0]
  const grid = useRef<HTMLDivElement>(null)
  const library = useRef<HTMLElement>(null)
  // "In this show": every scene not put away in the Scene library.
  const inShow = showScenes(state.scenes).filter((s) => !s.stored)
  const stored = showScenes(state.scenes).filter((s) => s.stored)
  const { drag, props } = useSceneDrag(run, inShow, state.scenes, state.programSceneId, grid, library)
  // While dragging, show the order it will have when dropped.
  const scenes = [...inShow]
  if (drag && !drag.toLibrary) {
    const from = scenes.findIndex((s) => s.id === drag.id)
    if (from >= 0) scenes.splice(drag.over, 0, ...scenes.splice(from, 1))
  }
  useSlide(grid, scenes.map((s) => s.id).join('|'))
  const dragged = drag && !drag.dropped ? state.scenes.find((s) => s.id === drag.id) : undefined
  const tally = (s: Scene) => ({
    live: s.id === state.programSceneId,
    next: s.id === state.previewSceneId && s.id !== state.programSceneId
  })
  return (
    <RunContext.Provider value={run}>
      <section className="scenes" aria-label="In this show">
        <div className="section-head">
          <h2>In this show</h2>
          <span className="muted small">
            Click to put in Preview, double-click to put it on air, drag to change the order or drag down to put it away. Cameras are switched on the ATEM.
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
            className={`scene-card floating ${tally(dragged).live ? 'tally-live' : ''} ${tally(dragged).next ? 'tally-next' : ''} ${drag.toLibrary ? 'to-library' : ''}`}
            style={{
              left: drag.x - drag.dx,
              top: drag.y - drag.dy,
              width: drag.w,
              height: drag.h
            }}
            aria-hidden="true"
          >
            <SceneCardBody scene={dragged} state={state} {...tally(dragged)} />
          </div>
        )}
        <SceneTools state={state} run={run} scene={preview} only="edit" />
      </section>
      <SceneLibrary
        state={state}
        run={run}
        scenes={stored}
        inShow={inShow}
        showGrid={grid}
        ref={library}
        dropping={!!dragged && !!drag?.toLibrary}
        dropBlocked={!!dragged && dragged.id === state.programSceneId}
      />
    </RunContext.Provider>
  )
}

function useRemembered(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved === null ? initial : saved === '1'
    } catch {
      return initial
    }
  })
  const set = (v: boolean) => {
    setValue(v)
    try {
      localStorage.setItem(key, v ? '1' : '0')
    } catch {
      // Not remembered; it still works for now.
    }
  }
  return [value, set]
}

/**
 * Scenes put away for this show. Tucked down to one line when closed (the
 * arrow remembers how you left it), so the main row stays short. Nothing in
 * here is deleted: a stored scene keeps all its sources.
 */
/**
 * Drag a scene from the Scene library up into "In this show". Drops at the
 * card nearest the pointer; a short press is still a click.
 */
function useLibraryDrag(run: Run, inShow: Scene[], all: Scene[], showGrid: RefObject<HTMLElement | null>) {
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; dx: number; dy: number; w: number; h: number; over: number | null } | null>(null)
  const start = useRef<{ id: string; x: number; y: number; pointer: number; rect: DOMRect } | null>(null)
  const moved = useRef(false)
  const latest = useRef(drag)
  latest.current = drag
  // Where in the show row it would land, or null when not over the row.
  const slotAt = (x: number, y: number) => {
    const g = showGrid.current
    if (!g) return null
    const box = g.getBoundingClientRect()
    if (x < box.left - 20 || x > box.right + 20 || y < box.top - 30 || y > box.bottom + 30) return null
    let best = inShow.length
    let bestD = Infinity
    for (const card of g.querySelectorAll<HTMLElement>('[data-scene-index]')) {
      const r = card.getBoundingClientRect()
      const d = Math.hypot((x - (r.left + r.width / 2)) / r.width, (y - (r.top + r.height / 2)) / r.height)
      if (d < bestD) {
        bestD = d
        // Left half of a card: in front of it; right half: after it.
        best = Number(card.dataset.sceneIndex) + (x > r.left + r.width / 2 ? 1 : 0)
      }
    }
    return best
  }
  const follow = (e: PointerEvent | ReactPointerEvent) => {
    const s = start.current
    if (!s || s.pointer !== e.pointerId) return
    if (!moved.current) {
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 8) return
      moved.current = true
    }
    setDrag({ id: s.id, x: e.clientX, y: e.clientY, dx: s.x - s.rect.left, dy: s.y - s.rect.top, w: s.rect.width, h: s.rect.height, over: slotAt(e.clientX, e.clientY) })
  }
  const finish = async () => {
    const s = start.current
    start.current = null
    const d = latest.current
    if (!s || !moved.current || !d) return
    setDrag(null)
    if (d.over === null) return
    const target = inShow[d.over]
    const ok = await run('scene.store', { sceneId: s.id, stored: false })
    if (!ok) return
    // Put it just before the card it was dropped on (the app keeps one list of all scenes).
    const others = all.filter((x) => x.id !== s.id)
    const index = target ? others.findIndex((x) => x.id === target.id) : others.length
    await run('scene.move', { sceneId: s.id, index })
  }
  useEffect(() => {
    const up = () => void finish()
    const move = (e: PointerEvent) => follow(e)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointermove', move)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointermove', move)
    }
  })
  const props = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      start.current = { id, x: e.clientX, y: e.clientY, pointer: e.pointerId, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() }
      moved.current = false
    },
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

function SceneLibrary(props: {
  state: AppState
  run: Run
  scenes: Scene[]
  inShow: Scene[]
  showGrid: RefObject<HTMLElement | null>
  ref: RefObject<HTMLElement | null>
  dropping: boolean
  dropBlocked: boolean
}) {
  const { state, run, scenes, inShow, showGrid, ref, dropping, dropBlocked } = props
  // Open unless you tucked it away; the arrow remembers.
  const [open, setOpen] = useRemembered(LIBRARY_OPEN_KEY, true)
  const { drag, props: dragProps } = useLibraryDrag(run, inShow, state.scenes, showGrid)
  const dragged = drag ? scenes.find((s) => s.id === drag.id) : undefined
  useEffect(() => {
    // Light up the show row while a library scene is over it.
    showGrid.current?.classList.toggle('drop-here', !!dragged && drag?.over !== null)
  }, [dragged, drag?.over, showGrid])
  const preview = state.scenes.find((s) => s.id === state.previewSceneId) ?? state.scenes[0]
  const [find, setFind] = useState('')
  const q = find.trim().toLowerCase()
  const shown = scenes.filter((s) => s.name.toLowerCase().includes(q))
  return (
    <section ref={ref} className={`scene-library ${open ? 'open' : ''} ${dropping ? (dropBlocked ? 'drop-blocked' : 'drop-here') : ''}`} aria-label="Scene library">
      <div className="library-head">
        <button className="library-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Tuck the Scene library away' : 'Show the Scene library'}>
          <span className="arrow" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <h2>Scene library</h2>
          <span className="count">{scenes.length}</span>
        </button>
        <SceneTools state={state} run={run} scene={preview} only="add" />
        {dropping ? (
          <span className="small">{dropBlocked ? 'This scene is on air, so it stays in the show.' : 'Let go to put it away here.'}</span>
        ) : open ? (
          <>
            <span className="muted small">Drag a scene up into "In this show" to use it. Nothing here is deleted.</span>
            {scenes.length > 4 && (
              <input
                id="scene-library-find"
                className="library-find"
                type="search"
                placeholder="Find a scene"
                aria-label="Find a scene"
                value={find}
                onChange={(e) => setFind(e.target.value)}
              />
            )}
          </>
        ) : (
          <span className="muted small">{scenes.length ? scenes.map((s) => s.name).join(', ') : 'Drag a scene here to put it away.'}</span>
        )}
      </div>
      {open && (
        <div className="library-grid">
          {shown.map((s) => {
            const next = s.id === state.previewSceneId
            return (
              <div key={s.id} className="library-item">
                <button
                  className={`scene-card ${next ? 'tally-next' : ''} ${dragged?.id === s.id ? 'dragging' : ''}`}
                  aria-pressed={next}
                  title="Drag up into In this show. Click to put in Preview, double-click to put it on air."
                  {...dragProps(s.id)}
                  onClick={() => run('scene.preview', { sceneId: s.id })}
                  onDoubleClick={() => run('scene.program', { sceneId: s.id })}
                >
                  <SceneCardBody scene={s} state={state} live={false} next={next} />
                </button>
                <button className="use-scene small" onClick={() => run('scene.store', { sceneId: s.id, stored: false })} title={`Bring ${s.name} into this show`}>
                  ↑ Use
                </button>
              </div>
            )
          })}
          {!shown.length && (
            <p className="muted small library-empty">
              {scenes.length ? 'No scene matches that name.' : 'Empty. Press "+ Add scene", or drag a scene here from "In this show".'}
            </p>
          )}
        </div>
      )}
      {dragged && drag && (
        <div
          className={`scene-card floating ${drag.over === null ? '' : 'to-show'}`}
          style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w, height: drag.h }}
          aria-hidden="true"
        >
          <SceneCardBody scene={dragged} state={state} live={false} next={false} />
        </div>
      )}
    </section>
  )
}

function SoundPanel(props: { state: AppState; stats: HealthStats | null; run: Run; studio: Studio | null; openSettings: (t: SettingsTab) => void }) {
  const { state, stats, run, studio, openSettings } = props
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const edited = state.audio.find((a) => a.id === editing)
  // Sound follows the scene: the one picked (in Preview), and only its channels, unless "Show all".
  const [showAll, setShowAll] = useState(false)
  const focus = state.scenes.find((s) => s.id === state.previewSceneId && !isOverlay(s))
  // Another scene picked: show its sound (not every channel, which hides the scene's own picker).
  useEffect(() => setShowAll(false), [focus?.id])
  const heard = focus ? state.audio.filter((a) => audible(a, new Set([focus.id]))) : state.audio
  const shown = showAll || !focus ? state.audio : focus.commercial ? [] : heard
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
          {studio && <ListenButton studio={studio} />}
          {!adding && (
            <button className="small" onClick={() => setAdding(true)}>
              + Add
            </button>
          )}
        </span>
      </div>
      {adding && <AddAudioForm state={state} run={run} onDone={() => setAdding(false)} />}
      {studio && <StreamMeter studio={studio} />}
      {focus && !showAll && <SceneSoundPicker scene={focus} state={state} run={run} heard={heard} />}
      <div className="strips">
        {shown.map((a) => (
          <Strip key={a.id} a={a} state={state} level={stats?.audioLevels[a.id] ?? 0} studio={studio} run={run} onEdit={() => setEditing(a.id)} inScene={focus && !showAll ? focus : undefined} />
        ))}
        {!showAll && focus && !focus.commercial && shown.length === 0 && (
          <p className="muted small sound-none">No sound in {focus.name}. Pick one above, or + Add a channel.</p>
        )}
        {showAll && shown.length === 0 && <p className="muted small sound-none">No sound channels yet. + Add one, or pick a scene’s sound.</p>}
        {focus?.commercial && <BreakStrip state={state} level={stats?.audioLevels[COMMERCIALS_CHANNEL] ?? 0} studio={studio} run={run} />}
      </div>
      {focus && (
        <button className="ghost small sound-all" aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? `Back to ${focus.name}’s sound` : `Show all sound channels (${state.audio.length})`}
        </button>
      )}
      {edited && <AudioEditor key={edited.id} state={state} run={run} source={edited} onDone={() => setEditing(null)} />}
    </section>
  )
}

/**
 * The sound of the scene in Preview: by default the one that comes with its
 * camera (ATEM audio with the ATEM's picture, the Z CAM's own sound); pick
 * another, or add more.
 */
function SceneSoundPicker({ scene, state, run, heard }: { scene: Scene; state: AppState; run: Run; heard: AudioSource[] }) {
  const cam = scene.layers.find((l) => l.kind === 'video' && l.device && l.visible) ?? scene.layers.find((l) => l.kind === 'video' && l.device)
  const pictureSrc = cam ? state.audio.find((a) => a.kind === 'video' && a.device === cam.device) : undefined
  const camName = cam ? (state.inputs.video.find((d) => d.id === cam.device)?.name ?? cam.name) : ''
  if (scene.commercial) {
    return (
      <div className="scene-sound-pick">
        <span className="small">
          Sound for <b>{scene.name}</b> <em className="tag next">PREVIEW</em>
        </span>
        <span className="small muted">Only the commercials’ sound (below). Every other channel is off while it’s live.</span>
      </div>
    )
  }
  const value = heard.length === 0 ? '' : heard.length > 1 ? '__several' : heard[0] === pictureSrc ? 'picture' : heard[0].id
  const others = state.audio.filter((a) => !heard.includes(a))
  return (
    <div className="scene-sound-pick">
      <span className="small">
        Sound for <b>{scene.name}</b> <em className="tag next">PREVIEW</em>
      </span>
      <label className="small">
        Sound for this scene
        <select
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (v !== '__several') run('scene.setSound', { sceneId: scene.id, sourceId: v === '' ? null : v })
          }}
        >
          {cam && <option value="picture">With the picture: {pictureSrc?.name ?? `${camName} sound`}</option>}
          {state.audio
            .filter((a) => a !== pictureSrc)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          {heard.length > 1 && <option value="__several">Several ({heard.length}): pick one to keep only it</option>}
          <option value="">No sound</option>
        </select>
      </label>
      {(others.length > 0 || (cam && !pictureSrc)) && (
        <label className="small">
          <select
            value=""
            aria-label="Add sound to this scene"
            onChange={(e) => e.target.value && run('scene.addSound', { sceneId: scene.id, sourceId: e.target.value })}
          >
            <option value="">+ Add sound to this scene</option>
            {cam && !pictureSrc && <option value="picture">{camName} sound (with the picture)</option>}
            {others.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

/**
 * The Commercials channel: one fader for every video in a gfx commercial break,
 * and what the mics do while a break is on air.
 */
function BreakStrip(props: { state: AppState; level: number; studio: Studio | null; run: Run }) {
  const { state, level, studio, run } = props
  const scene = state.scenes.find((s) => s.commercial)
  if (!scene) return null
  const bs = { ...BREAK_SOUND, ...scene.breakSound }
  const media = scene.layers.filter((l) => l.kind === 'media')
  const at = media.findIndex((l) => l.visible)
  const onAir = state.programSceneId === scene.id && media.length > 0
  const now = !media.length ? 'Nothing cued' : onAir ? `Now: ${media[Math.max(0, at)].name}${media.length > 1 ? ` (${at + 1} of ${media.length})` : ''}` : `${media.length} cued · plays with the Gfx commercial scene`
  return (
    <div className={`strip break-strip ${bs.muted ? 'muted' : ''} ${onAir ? '' : 'off-air'}`}>
      <div className="strip-head">
        <strong>Commercials</strong>
        {onAir && <em className="tag live">ON AIR</em>}
        {studio && media.length > 0 && <SoloButton studio={studio} id={COMMERCIALS_CHANNEL} name="Commercials" />}
        <button className={`small mute ${bs.muted ? 'danger' : ''}`} aria-pressed={bs.muted} onClick={() => run('cue.sound', { muted: !bs.muted })}>
          {bs.muted ? 'Muted' : 'Mute'}
        </button>
      </div>
      <span className="small muted">{now} · one fader for every video in the break</span>
      <div className="strip-level">
        <div className="hmeter">{studio ? <LiveMeter studio={studio} id={COMMERCIALS_CHANNEL} horizontal /> : <div className="meter" style={{ width: `${Math.round(level * 100)}%` }} />}</div>
        <input type="range" min={0} max={100} value={Math.round(bs.volume * 100)} aria-label="Commercials volume" onChange={(e) => run('cue.sound', { volume: Number(e.target.value) / 100 })} />
      </div>
      <span className={`small ${onAir ? 'warn-text' : 'muted'}`}>Only the videos’ sound: every other channel is off while the break is live.</span>
    </div>
  )
}

const LISTEN_KEY = 'listen-output-v1'

/**
 * Listen: hear everything that goes out to the stream on headphones or
 * speakers of this PC, at its own volume. It never changes the stream.
 * Off each time the app starts (speakers near a live mic would echo).
 */
function ListenButton({ studio }: { studio: Studio }) {
  const [m, setM] = useState(studio.mixer.monitor)
  const [open, setOpen] = useState(false)
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState('')
  const [solo, setSolo] = useState(studio.mixer.solo)
  useEffect(
    () =>
      studio.mixer.onMonitor(() => {
        setM({ ...studio.mixer.monitor })
        setSolo(studio.mixer.solo)
      }),
    [studio]
  )
  useEffect(() => {
    // The output and volume picked last time (not whether it was on).
    try {
      const saved = JSON.parse(localStorage.getItem(LISTEN_KEY) ?? 'null') as { device?: string; volume?: number } | null
      if (saved && !studio.mixer.monitor.on) {
        studio.mixer.monitor = { ...studio.mixer.monitor, device: saved.device ?? '', volume: saved.volume ?? 0.8 }
        setM(studio.mixer.monitor)
      }
    } catch {
      // no saved choice
    }
    const list = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((d) => setOuts(d.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'default' && x.deviceId !== 'communications')))
        .catch(() => {})
    list()
    navigator.mediaDevices?.addEventListener('devicechange', list)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', list)
  }, [studio])
  const change = async (p: Partial<typeof m>) => {
    setError('')
    try {
      await studio.mixer.setMonitor(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setM({ ...studio.mixer.monitor })
    try {
      localStorage.setItem(LISTEN_KEY, JSON.stringify({ device: studio.mixer.monitor.device, volume: studio.mixer.monitor.volume }))
    } catch {
      // not kept
    }
  }
  const name = outs.find((o) => o.deviceId === m.device)?.label || 'Windows default output'
  return (
    <span className="listen">
      <button
        className={`small ${m.on ? 'listen-on' : 'ghost'}`}
        aria-pressed={m.on}
        title="Hear everything that goes out to the stream, on headphones or speakers of this PC"
        onClick={() => {
          if (!m.on) setOpen(true)
          else void studio.mixer.setSolo(null)
          void change({ on: !m.on })
        }}
      >
        <HeadphonesIcon /> {m.on ? (solo ? 'Listening (solo)' : 'Listening') : 'Listen'}
      </button>
      <button className="ghost small icon" aria-label="Listen settings" aria-expanded={open} onClick={() => setOpen(!open)}>
        ▾
      </button>
      {open && (
        <div className="listen-pop" role="group" aria-label="Listen to the stream">
          <strong>Listen to the stream</strong>
          <span className="small muted">Everything that goes out, a little behind the room. Use headphones near a live mic, or it echoes.</span>
          <label className="small">
            Hear it on
            <select value={m.device} onChange={(e) => void change({ device: e.target.value })}>
              <option value="">Windows default output</option>
              {outs.map((o) => (
                <option key={o.deviceId} value={o.deviceId}>
                  {o.label || 'An output'}
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            Listen volume (the stream doesn’t change)
            <input type="range" min={0} max={100} value={Math.round(m.volume * 100)} onChange={(e) => void change({ volume: Number(e.target.value) / 100 })} />
          </label>
          <span className="small muted">{m.on ? `On: ${name}` : 'Off'}{m.on && solo ? ' · one channel alone (press its headphones again for the whole stream)' : ''}</span>
          {error && <span className="small warn-text">Could not play on that output: {error}</span>}
          <button className="small" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      )}
    </span>
  )
}

/** Hear this channel alone in the headphones (press again for the whole stream). */
function SoloButton({ studio, id, name }: { studio: Studio; id: string; name: string }) {
  const [on, setOn] = useState(studio.mixer.solo === id && studio.mixer.monitor.on)
  useEffect(() => {
    const sync = () => setOn(studio.mixer.solo === id && studio.mixer.monitor.on)
    sync()
    return studio.mixer.onMonitor(sync)
  }, [studio, id])
  return (
    <button
      className={`ghost icon solo ${on ? 'on' : ''}`}
      aria-pressed={on}
      aria-label={`Listen to ${name} alone`}
      title={on ? 'Listening to this alone · press for the whole stream' : 'Listen to this alone in your headphones (even before it is on air)'}
      onClick={() => void studio.mixer.setSolo(on ? null : id).catch(() => {})}
    >
      <HeadphonesIcon />
    </button>
  )
}

/** Left and right of what goes out to the stream, with a red mark when it gets too loud (near 0 dB). */
function StreamMeter({ studio }: { studio: Studio }) {
  const bars = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)]
  const clip = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let frame = 0
    const shown = [0, 0]
    let loudUntil = 0
    const loop = () => {
      const lv = studio.mixer.streamLevels()
      lv.forEach((v, i) => {
        shown[i] = v > shown[i] ? v : shown[i] * 0.9
        const el = bars[i].current
        if (el) el.style.width = `${Math.round(Math.sqrt(shown[i]) * 100)}%`
      })
      if (Math.max(...lv) >= 0.89) loudUntil = performance.now() + 2000
      if (clip.current) clip.current.hidden = performance.now() > loudUntil
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio])
  return (
    <div className="stream-meter" title="What goes out to the stream, left and right">
      <span className="small muted">Stream</span>
      <div className="stream-meter-bars">
        {['L', 'R'].map((side, i) => (
          <div key={side} className="stream-meter-row">
            <span className="small muted">{side}</span>
            <div className="hmeter">
              <div ref={bars[i]} className="meter" />
            </div>
          </div>
        ))}
      </div>
      <span ref={clip} className="tag live" hidden>
        TOO LOUD
      </span>
    </div>
  )
}

function HeadphonesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />
    </svg>
  )
}

/** One sound channel, as a row: name, device, meter, volume, mute. */
/** Where a sound comes from, by the device's real name, and whether its device is missing. */
function soundFrom(a: AudioSource, state: AppState) {
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
  const chs = a.channels ? (a.channels.length === 1 ? `input ${a.channels[0]}` : `inputs ${a.channels.join(' + ')}`) : ''
  return { from, chs, unplugged }
}

/**
 * The sound that plays when this scene is on air, under its card: one line
 * each with the real device and a small meter. Sound set to every scene is
 * counted in one line, so it doesn't repeat on every card.
 */
function SceneSounds({ scene, state, studio }: { scene: Scene; state: AppState; studio: Studio | null }) {
  const own = state.audio.filter((a) => a.scenes?.includes(scene.id))
  const every = state.audio.filter((a) => !a.scenes)
  if (!own.length && !every.length) return null
  return (
    <span className="scene-sounds">
      {own.map((a) => {
        const { from, chs, unplugged } = soundFrom(a, state)
        const where = [from, chs].filter(Boolean).join(' ')
        return (
          <span key={a.id} className={`scene-sound ${a.muted ? 'muted' : ''} ${unplugged ? 'missing' : ''}`} title={`${a.name} · ${where}${a.muted ? ' (muted)' : ''}`}>
            <span className="sound-icon" aria-hidden="true">
              {a.kind === 'video' ? '▣' : a.kind === 'file' ? '♪' : a.kind === 'desktop' ? '▭' : '●'}
            </span>
            <span className="sound-label">
              <span>{a.name}</span>
              <small>{where}</small>
            </span>
            <span className="hmeter">{studio ? <LiveMeter studio={studio} id={a.id} horizontal /> : <span className="meter" style={{ width: `${Math.round(a.level * 100)}%` }} />}</span>
          </span>
        )
      })}
      {every.length > 0 && (
        <span className="scene-sound-every" title={`In every scene: ${every.map((a) => a.name).join(', ')}`}>
          {own.length ? '+ ' : ''}
          {every.length} in every scene
        </span>
      )}
    </span>
  )
}

function Strip(props: { a: AudioSource; state: AppState; level: number; studio: Studio | null; run: Run; onEdit: () => void; inScene?: Scene }) {
  const { a, state, level, studio, run, onEdit, inScene } = props
  const { from, chs, unplugged } = soundFrom(a, state)
  // Sound follows the scene: heard only while one of its scenes is on air.
  const onAir = audible(a, scenesOnAir(state))
  const where = a.scenes
    ? a.scenes.map((id) => state.scenes.find((x) => x.id === id)?.name).filter(Boolean).join(', ')
    : 'Every scene'
  return (
    <div className={`strip ${a.muted ? 'muted' : ''} ${onAir ? '' : 'off-air'}`}>
      <div className="strip-head">
        <strong>{a.name}</strong>
        {onAir && a.scenes && <em className="tag live" title="Its scene is on air">ON AIR</em>}
        {a.syncOffsetMs > 0 && <span className="muted small">+{a.syncOffsetMs} ms</span>}
        {studio && <SoloButton studio={studio} id={a.id} name={a.name} />}
        <span className="strip-tools">
          <button className="ghost icon" aria-label={`Edit ${a.name}`} title="Name, device, inputs, sync offset" onClick={onEdit}>
            ✎
          </button>
          {inScene ? (
            <button className="ghost icon" aria-label={`Take ${a.name} out of ${inScene.name}`} title={`Take out of ${inScene.name} (the channel stays for other scenes)`} onClick={() => run('scene.removeSound', { sceneId: inScene.id, sourceId: a.id })}>
              ✕
            </button>
          ) : (
            <button className="ghost icon" aria-label={`Remove ${a.name}`} title="Remove channel" onClick={() => run('audio.remove', { sourceId: a.id })}>
              ✕
            </button>
          )}
        </span>
        <button className={`small mute ${a.muted ? 'danger' : ''}`} aria-pressed={a.muted} onClick={() => run('audio.setMuted', { sourceId: a.id, muted: !a.muted })}>
          {a.muted ? 'Muted' : 'Mute'}
        </button>
      </div>
      <span className={`small ${unplugged ? 'warn-text' : 'muted'}`}>{[from, chs].filter(Boolean).join(' · ')}</span>
      <span className="small muted strip-where" title="Change in ✎">
        Plays in: {where || 'no scene'}
        {!a.scenes && inScene && !inScene.commercial && (
          <button
            className="ghost small"
            title={`Play ${a.name} only in ${inScene.name}, so it stays off in every other scene`}
            onClick={() => run('audio.update', { sourceId: a.id, scenes: [inScene.id] })}
          >
            Only in {inScene.name}
          </button>
        )}
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
