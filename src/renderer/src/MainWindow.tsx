import { useEffect, useState } from 'react'
import type { AppState, AudioSource, HealthStats } from '../../shared/state'
import { PLATFORMS, QUALITY_PRESETS } from '../../shared/presets'
import type { Bridge } from './bridge/bridge'
import { AddAudioForm, AudioEditor, SceneTools, SourceList } from './Editors'
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
    <div className="monitors">
      <section className="monitor program" aria-label="Live">
        <div className="monitor-head">
          <span className="badge live">{state.stream.live ? 'ON AIR' : 'LIVE PICTURE'}</span>
          <strong>{program.name}</strong>
          <span className="muted small push">
            {state.stream.live ? `Live ${liveFor} on ${onCount} platform${onCount === 1 ? '' : 's'}` : 'Not streaming'}
          </span>
        </div>
        {studio ? <LiveCanvas canvas={studio.compositor.program} live /> : <ScenePicture scene={program} state={state} live />}
      </section>
      <section className="monitor next" aria-label="Next">
        <div className="monitor-head">
          <span className="badge next">NEXT</span>
          <strong>{preview.name}</strong>
        </div>
        {studio ? <LiveCanvas canvas={studio.compositor.preview} next /> : <ScenePicture scene={preview} state={state} next />}
        <div className="segmented wide" role="group" aria-label="Transition">
          {(['cut', 'fade'] as const).map((k) => (
            <button key={k} className={state.transition.kind === k ? 'on' : ''} aria-pressed={state.transition.kind === k} onClick={() => run('transition.set', { kind: k })}>
              {k === 'cut' ? 'Cut' : `Fade ${state.transition.durationMs / 1000} s`}
            </button>
          ))}
        </div>
        <button className="take" onClick={() => run('scene.goLive')} disabled={same}>
          {same ? 'Already on air' : `Take ${preview.name} to air`}
        </button>
      </section>
    </div>
  )
}

function SceneStrip({ state, run }: { state: AppState; run: Run }) {
  const preview = state.scenes.find((s) => s.id === state.previewSceneId) ?? state.scenes[0]
  return (
    <section className="scenes" aria-label="Scenes">
      <div className="section-head">
        <h2>Scenes</h2>
        <span className="muted small">Click to put in Next, double-click to take it to air. Cameras are switched on the ATEM.</span>
      </div>
      <div className="scene-grid">
        {state.scenes.map((s) => {
          const live = s.id === state.programSceneId
          const next = s.id === state.previewSceneId && !live
          return (
            <button
              key={s.id}
              className={`scene-card ${live ? 'tally-live' : ''} ${next ? 'tally-next' : ''}`}
              aria-pressed={next}
              onClick={() => run('scene.preview', { sceneId: s.id })}
              onDoubleClick={() => run('scene.program', { sceneId: s.id })}
            >
              <ScenePicture scene={s} state={state} />
              <span className="scene-name">
                <span>{s.name}</span>
                {live && <em className="tag live">ON AIR</em>}
                {next && <em className="tag next">NEXT</em>}
              </span>
            </button>
          )
        })}
      </div>
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
  const unplugged = a.kind !== 'desktop' && !dev && !usesDefault
  const from = a.kind === 'desktop' ? 'This PC' : usesDefault ? 'Windows default mic' : (dev?.name ?? 'Unplugged')
  const chs = a.channels ? (a.channels.length === 1 ? `input ${a.channels[0]}` : `inputs ${a.channels.join(' + ')}`) : ''
  return (
    <div className={`strip ${a.muted ? 'muted' : ''}`}>
      <div className="strip-head">
        <strong>{a.name}</strong>
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
