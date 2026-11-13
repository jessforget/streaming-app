/** Tablet remote: big touch targets for scenes, cameras, audio and going live. */
import { useEffect, useMemo, useState } from 'react'
import type { Bridge } from './bridge/bridge'
import { WsBridge } from './bridge/wsBridge'
import { CameraButtons, HealthPill, Notice } from './parts'
import { useApp, useElapsed } from './useApp'

export function RemoteScreen(props: { bridge: Bridge; deviceName?: string; onForget?: () => void; confirmStop?: () => boolean }) {
  const { bridge, deviceName, onForget, confirmStop = confirmStopDefault } = props
  const { state, stats, run, notice, clearNotice } = useApp(bridge)
  const liveFor = useElapsed(state?.stream.startedAt ?? null)
  if (!state) return <div className="loading">Connecting…</div>
  const preview = state.scenes.find((s) => s.id === state.previewSceneId)
  return (
    <div className="remote">
      <header className="remote-top">
        {state.stream.live ? <span className="pill live-pill">LIVE {liveFor}</span> : <span className="pill">Off air</span>}
        <HealthPill stats={stats} />
        <div className="remote-top-actions">
          <button
            className={state.recording.active ? 'danger' : ''}
            onClick={() => run(state.recording.active ? 'record.stop' : 'record.start')}
          >
            {state.recording.active ? 'Stop rec' : 'Record'}
          </button>
          {state.stream.live ? (
            <button className="danger strong" onClick={() => confirmStop() && run('stream.stop')}>
              Stop stream
            </button>
          ) : (
            <button className="accent strong" onClick={() => run('stream.start')}>
              Start stream
            </button>
          )}
        </div>
      </header>
      <Notice text={notice} onClose={clearNotice} />
      <div className="remote-grid">
        <section>
          <h2>Scenes</h2>
          <div className="remote-scenes">
            {state.scenes.map((s) => {
              const live = s.id === state.programSceneId
              const next = s.id === state.previewSceneId && !live
              return (
                <button
                  key={s.id}
                  className={`remote-scene ${live ? 'tally-live' : ''} ${next ? 'tally-next' : ''}`}
                  onClick={() => run('scene.preview', { sceneId: s.id })}
                >
                  {s.name}
                  {live && <small>On air</small>}
                  {next && <small>Next</small>}
                </button>
              )
            })}
          </div>
          <button
            className="accent strong remote-golive"
            disabled={!preview || preview.id === state.programSceneId}
            onClick={() => run('scene.goLive')}
          >
            Go Live Scene{preview ? `: ${preview.name}` : ''}
          </button>
          <h2>Cameras</h2>
          <CameraButtons state={state} run={run} big />
        </section>
        <section>
          <h2>Audio</h2>
          <div className="remote-audio">
            {state.audio.map((a) => (
              <div key={a.id} className={`remote-fader ${a.muted ? 'muted' : ''}`}>
                <span>{a.name}</span>
                <div className="hmeter">
                  <div style={{ width: `${Math.round((stats?.audioLevels[a.id] ?? 0) * 100)}%` }} />
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(a.volume * 100)}
                  aria-label={`${a.name} volume`}
                  onChange={(e) => run('audio.setVolume', { sourceId: a.id, volume: Number(e.target.value) / 100 })}
                />
                <button className={a.muted ? 'danger' : ''} onClick={() => run('audio.setMuted', { sourceId: a.id, muted: !a.muted })}>
                  {a.muted ? 'Muted' : 'Mute'}
                </button>
              </div>
            ))}
          </div>
          <h2>Quick actions</h2>
          <div className="quick">
            <button onClick={() => run('audio.muteAll')}>Mute all</button>
            <button onClick={() => run('atem.cut')} disabled={!state.atem.connected}>
              ATEM Cut
            </button>
          </div>
          <p className="muted small remote-foot">
            {deviceName ? `${deviceName} · ` : ''}Connected to {state.setupName}
            {onForget && (
              <>
                {' · '}
                <button className="link" onClick={onForget}>
                  Unpair this tablet
                </button>
              </>
            )}
          </p>
        </section>
      </div>
    </div>
  )
}

function confirmStopDefault() {
  // A stray tap must not end the show.
  return window.confirm('Stop the stream for everyone?')
}

/** The real tablet page: pair once, then straight to the remote. */
export function RemoteApp() {
  const bridge = useMemo(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return new WsBridge(`${proto}//${location.host}/ws`)
  }, [])
  const [status, setStatus] = useState<string>('connecting')
  const [detail, setDetail] = useState<string | undefined>()
  const codeFromLink = new URLSearchParams(location.hash.slice(1)).get('code') ?? ''
  const [code, setCode] = useState(codeFromLink)
  const [name, setName] = useState(() => (/iPad/.test(navigator.userAgent) ? 'iPad' : 'Tablet'))

  useEffect(() => {
    const off = bridge.onStatus((s, d) => {
      setStatus(s)
      setDetail(d)
    })
    bridge.connect()
    return () => {
      off()
    }
  }, [bridge])

  if (status === 'needs-pairing') {
    return (
      <div className="pair-screen">
        <h1>Pair this tablet</h1>
        <p className="muted">Type the 6-digit code shown on the streaming PC under Settings, Remote and devices.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            history.replaceState(null, '', location.pathname)
            bridge.pair(code.replace(/\s/g, ''), name)
          }}
        >
          <input className="code-input" inputMode="numeric" maxLength={7} placeholder="000 000" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          <input placeholder="Name for this tablet" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          <button className="accent strong" disabled={code.replace(/\s/g, '').length !== 6}>
            Pair
          </button>
        </form>
        {detail && <p className="error-text">{detail}</p>}
      </div>
    )
  }
  if (status !== 'connected') {
    return <div className="loading">{status === 'offline' ? 'Lost the connection. Reconnecting…' : 'Connecting…'}</div>
  }
  return <RemoteScreen bridge={bridge} deviceName={bridge.name} onForget={() => bridge.forget()} />
}
