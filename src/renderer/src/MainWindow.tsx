import { useState } from 'react'
import type { AppState, AudioSource, HealthStats } from '../../shared/state'
import { PLATFORMS } from '../../shared/presets'
import type { Bridge } from './bridge/bridge'
import { AddAudioForm, AudioEditor, SceneTools, SourceList } from './Editors'
import { HealthPill, Notice, ScenePicture } from './parts'
import { Settings, type SettingsTab } from './Settings'
import { useApp, useElapsed, type Run } from './useApp'

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
      <SceneTools state={state} run={run} scene={state.scenes.find((s) => s.id === state.previewSceneId) ?? state.scenes[0]} />
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
      <SourceList state={state} run={run} scene={preview} />
    </section>
  )
}

function RightColumn(props: { state: AppState; stats: HealthStats | null; run: Run; openSettings: (t: SettingsTab) => void }) {
  const { state, stats, run, openSettings } = props
  const [addingAudio, setAddingAudio] = useState(false)
  const [editingAudio, setEditingAudio] = useState<string | null>(null)
  const editing = state.audio.find((a) => a.id === editingAudio)
  return (
    <section className="col right">
      <div className="panel">
        <div className="panel-head">
          <h2>Audio</h2>
          <span className="row">
            <button className="ghost small" onClick={() => openSettings('inputs')}>
              Inputs
            </button>
            <button className="ghost small" onClick={() => run('audio.muteAll')}>
              Mute all
            </button>
          </span>
        </div>
        <div className="mixer">
          {state.audio.map((a) => (
            <Fader key={a.id} a={a} state={state} level={stats?.audioLevels[a.id] ?? 0} run={run} onEdit={() => setEditingAudio(a.id)} />
          ))}
        </div>
        {editing && <AudioEditor key={editing.id} state={state} run={run} source={editing} onDone={() => setEditingAudio(null)} />}
        {addingAudio ? (
          <AddAudioForm state={state} run={run} onDone={() => setAddingAudio(false)} />
        ) : (
          <button className="small add-audio" onClick={() => setAddingAudio(true)}>
            + Add audio
          </button>
        )}
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

function Fader(props: { a: AudioSource; state: AppState; level: number; run: Run; onEdit: () => void }) {
  const { a, state, level, run, onEdit } = props
  const dev = [...state.inputs.audio, ...state.inputs.video].find((d) => d.id === a.device)
  const unplugged = a.kind !== 'desktop' && !dev
  const from = a.kind === 'desktop' ? 'Desktop sound' : (dev?.name ?? 'Device not plugged in')
  const chs = a.channels ? `Ch ${a.channels.join('+')}` : ''
  const detail = [chs, a.syncOffsetMs ? `${a.syncOffsetMs > 0 ? '+' : ''}${a.syncOffsetMs} ms` : ''].filter(Boolean).join(' · ')
  return (
    <div className={`fader ${a.muted ? 'muted' : ''}`} title={`${from}${a.channels ? `, channel ${a.channels.join(' and ')}` : ''}`}>
      <span className="fader-tools">
        <button className="ghost icon" aria-label={`Edit ${a.name}`} title="Name, channels, sync offset" onClick={onEdit}>
          ✎
        </button>
        <button className="ghost icon" aria-label={`Remove ${a.name}`} title="Remove channel" onClick={() => run('audio.remove', { sourceId: a.id })}>
          ✕
        </button>
      </span>
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
      <small className={`fader-detail ${unplugged ? 'warn-text' : ''}`}>{unplugged ? 'Unplugged' : detail}</small>
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
