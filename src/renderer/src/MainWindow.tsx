import { useState } from 'react'
import type { AppState, AudioSource, HealthStats, Layer } from '../../shared/state'
import { PLATFORMS } from '../../shared/presets'
import type { Bridge } from './bridge/bridge'
import { CameraButtons, HealthPill, Notice, ScenePicture } from './parts'
import { Settings, type SettingsTab } from './Settings'
import { useApp, useElapsed, type Run } from './useApp'

const KIND_LABEL: Record<Layer['kind'], string> = {
  atem: 'ATEM',
  webcam: 'Webcam',
  screen: 'Screen',
  window: 'Window',
  image: 'Image',
  text: 'Text',
  browser: 'Browser',
  media: 'Media'
}

export function MainWindow({ bridge }: { bridge: Bridge }) {
  const { state, stats, run, notice, clearNotice } = useApp(bridge)
  const [settings, setSettings] = useState<SettingsTab | null>(null)
  if (!state) return <div className="loading">Starting…</div>
  return (
    <div className="app">
      <TopBar state={state} stats={stats} run={run} openSettings={setSettings} />
      <Notice text={notice} onClose={clearNotice} />
      <div className="workspace">
        <ScenesColumn state={state} run={run} />
        <CenterColumn state={state} run={run} />
        <RightColumn state={state} stats={stats} run={run} openSettings={setSettings} />
      </div>
      {settings && <Settings state={state} run={run} tab={settings} onTab={setSettings} onClose={() => setSettings(null)} />}
    </div>
  )
}

function TopBar(props: { state: AppState; stats: HealthStats | null; run: Run; openSettings: (t: SettingsTab) => void }) {
  const { state, stats, run, openSettings } = props
  const liveFor = useElapsed(state.stream.startedAt)
  const recFor = useElapsed(state.recording.startedAt)
  const enabled = state.stream.destinations.filter((d) => d.enabled)
  const where = enabled.map((d) => PLATFORMS[d.platform].label).join(', ')
  return (
    <header className="topbar">
      <div className="setup-name">
        <strong>{state.setupName}</strong>
        {state.engine.mode === 'simulated' && (
          <span className="pill practice" title={state.engine.note}>
            Practice mode
          </span>
        )}
      </div>
      <HealthPill stats={stats} />
      <div className="topbar-actions">
        <button className="ghost" onClick={() => openSettings('golive')}>
          Settings
        </button>
        <button
          className={state.recording.active ? 'danger' : ''}
          onClick={() => run(state.recording.active ? 'record.stop' : 'record.start')}
        >
          {state.recording.active ? `Stop recording ${recFor}` : 'Record'}
        </button>
        {state.stream.live ? (
          <button className="danger strong" onClick={() => run('stream.stop')}>
            Stop stream {liveFor}
          </button>
        ) : (
          <button
            className="accent strong"
            onClick={() => run('stream.start')}
            title={where ? `Go live on ${where}` : 'Pick a platform in Settings first'}
          >
            Start stream{enabled.length > 1 ? ` (${enabled.length})` : ''}
          </button>
        )}
      </div>
    </header>
  )
}

function ScenesColumn({ state, run }: { state: AppState; run: Run }) {
  return (
    <section className="col scenes" aria-label="Scenes">
      <h2>Scenes</h2>
      <div className="scene-list">
        {state.scenes.map((s) => {
          const live = s.id === state.programSceneId
          const next = s.id === state.previewSceneId && !live
          return (
            <button
              key={s.id}
              className={`scene-card ${live ? 'tally-live' : ''} ${next ? 'tally-next' : ''}`}
              onClick={() => run('scene.preview', { sceneId: s.id })}
              onDoubleClick={() => run('scene.program', { sceneId: s.id })}
              title="Click to queue in Preview, double-click to put on air"
            >
              <ScenePicture scene={s} state={state} />
              <span className="scene-name">
                {s.name}
                {live && <em className="tag live">On air</em>}
                {next && <em className="tag next">Next</em>}
              </span>
            </button>
          )
        })}
      </div>
      <p className="hint">Click to queue a scene. Double-click to put it on air right away.</p>
    </section>
  )
}

function CenterColumn({ state, run }: { state: AppState; run: Run }) {
  const preview = state.scenes.find((s) => s.id === state.previewSceneId) ?? state.scenes[0]
  const program = state.scenes.find((s) => s.id === state.programSceneId) ?? state.scenes[0]
  return (
    <section className="col center">
      <div className="monitors">
        <figure>
          <figcaption>
            Preview: <strong>{preview.name}</strong>
          </figcaption>
          <ScenePicture scene={preview} state={state} />
        </figure>
        <figure>
          <figcaption className="live-caption">
            Live: <strong>{program.name}</strong>
          </figcaption>
          <ScenePicture scene={program} state={state} live />
        </figure>
      </div>
      <div className="golive-row">
        <div className="segmented" role="group" aria-label="Transition">
          {(['cut', 'fade'] as const).map((k) => (
            <button key={k} className={state.transition.kind === k ? 'on' : ''} onClick={() => run('transition.set', { kind: k })}>
              {k === 'cut' ? 'Cut' : `Fade ${state.transition.durationMs / 1000} s`}
            </button>
          ))}
        </div>
        <button className="accent strong golive" onClick={() => run('scene.goLive')} disabled={preview.id === program.id}>
          Go Live Scene: {preview.name}
        </button>
      </div>
      <div className="layers">
        <h2>Layers in {preview.name}</h2>
        <ul>
          {preview.layers.map((l) => (
            <li key={l.id} className={l.visible ? '' : 'hidden-layer'}>
              <label className="switch" title={l.visible ? 'Hide' : 'Show'}>
                <input
                  type="checkbox"
                  checked={l.visible}
                  onChange={(e) => run('layer.setVisible', { sceneId: preview.id, layerId: l.id, visible: e.target.checked })}
                />
                <span />
              </label>
              <span className="layer-name">{l.name}</span>
              <span className="layer-kind">{KIND_LABEL[l.kind]}</span>
              {l.text && <code className="layer-text">{l.text}</code>}
            </li>
          ))}
        </ul>
        <p className="hint">Top of the list shows in front. Text in braces, like {'{guest.name}'}, comes from the companion app.</p>
      </div>
    </section>
  )
}

function RightColumn(props: { state: AppState; stats: HealthStats | null; run: Run; openSettings: (t: SettingsTab) => void }) {
  const { state, stats, run, openSettings } = props
  return (
    <section className="col right">
      <div className="panel">
        <div className="panel-head">
          <h2>Cameras {state.atem.model ? <small>({state.atem.model})</small> : null}</h2>
          <button className="ghost small" onClick={() => openSettings('atem')}>
            ATEM settings
          </button>
        </div>
        <CameraButtons state={state} run={run} />
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Audio</h2>
          <button className="ghost small" onClick={() => run('audio.muteAll')}>
            Mute all
          </button>
        </div>
        <div className="mixer">
          {state.audio.map((a) => (
            <Fader key={a.id} a={a} level={stats?.audioLevels[a.id] ?? 0} run={run} />
          ))}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Data fields</h2>
          <button className="ghost small" onClick={() => openSettings('devices')}>
            Devices
          </button>
        </div>
        <DataTable state={state} />
      </div>
    </section>
  )
}

function Fader({ a, level, run }: { a: AudioSource; level: number; run: Run }) {
  return (
    <div className={`fader ${a.muted ? 'muted' : ''}`}>
      <div className="fader-track">
        <div className="meter" style={{ height: `${Math.round(level * 100)}%` }} />
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(a.volume * 100)}
          aria-label={`${a.name} volume`}
          onChange={(e) => run('audio.setVolume', { sourceId: a.id, volume: Number(e.target.value) / 100 })}
        />
      </div>
      <span className="fader-name">{a.name}</span>
      <button className={`small ${a.muted ? 'danger' : ''}`} onClick={() => run('audio.setMuted', { sourceId: a.id, muted: !a.muted })}>
        {a.muted ? 'Muted' : 'Mute'}
      </button>
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
