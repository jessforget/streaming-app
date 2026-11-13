/** Pieces shared by the main window and the tablet remote. */
import type { AppState, HealthStats, Scene } from '../../shared/state'
import { renderTemplate } from '../../shared/template'
import type { Run } from './useApp'

export function HealthPill({ stats }: { stats: HealthStats | null }) {
  const h = stats?.health ?? 'idle'
  return (
    <span className={`pill health-${h}`} role="status" title={stats?.message}>
      <span className="dot" />
      {stats?.message ?? 'Ready'}
    </span>
  )
}

/** A drawing of a scene: what viewers would see. The real video preview comes from the engine (Phase 2). */
export function ScenePicture({ scene, state, live }: { scene: Scene; state: AppState; live?: boolean }) {
  const visible = scene.layers.filter((l) => l.visible)
  const atem = visible.find((l) => l.kind === 'atem')
  const cam = state.atem.inputs.find((i) => i.id === state.atem.program)
  const texts = visible.filter((l) => l.kind === 'text' && l.text)
  const title = texts.find((l) => l.id.endsWith('-title'))
  const lower = texts.find((l) => l.id.endsWith('lower-third'))
  const score = texts.find((l) => l.id.endsWith('score'))
  return (
    <div className={`picture ${live ? 'is-live' : ''} ${atem ? 'has-camera' : ''}`}>
      {atem && (
        <div className="picture-camera">
          {state.atem.connected ? `ATEM · ${cam ? `Cam ${cam.id} ${cam.longName}` : 'program'}` : 'ATEM not connected'}
        </div>
      )}
      {title && <div className="picture-title">{renderTemplate(title.text!, state.data)}</div>}
      {score && <div className="picture-score">{renderTemplate(score.text!, state.data)}</div>}
      {lower && renderTemplate(lower.text!, state.data).trim() && (
        <div className="picture-lower">{renderTemplate(lower.text!, state.data)}</div>
      )}
    </div>
  )
}

export function CameraButtons({ state, run, big }: { state: AppState; run: Run; big?: boolean }) {
  const a = state.atem
  if (!a.connected) {
    return <p className="muted">{a.host ? `Connecting to the ATEM at ${a.host}…` : 'No ATEM set up yet. Add its address in Settings.'}</p>
  }
  return (
    <div className={`cameras ${big ? 'big' : ''}`}>
      <div className="cam-row">
        <span className="row-label">On air</span>
        {a.inputs.map((i) => (
          <button
            key={i.id}
            className={`cam ${a.program === i.id ? 'tally-live' : ''}`}
            onClick={() => run('atem.program', { input: i.id })}
            title={`Put Cam ${i.id} on air now`}
          >
            <strong>Cam {i.id}</strong>
            <small>{i.longName}</small>
          </button>
        ))}
      </div>
      <div className="cam-row">
        <span className="row-label">Next</span>
        {a.inputs.map((i) => (
          <button
            key={i.id}
            className={`cam ${a.preview === i.id ? 'tally-next' : ''}`}
            onClick={() => run('atem.preview', { input: i.id })}
            title={`Queue Cam ${i.id}`}
          >
            <strong>Cam {i.id}</strong>
          </button>
        ))}
      </div>
      <div className="cam-actions">
        <button onClick={() => run('atem.cut')}>Cut</button>
        <button className="accent" onClick={() => run('atem.auto')} disabled={a.inTransition}>
          {a.inTransition ? 'Mixing…' : 'Auto'}
        </button>
      </div>
    </div>
  )
}

export function Notice({ text, onClose }: { text: string | null; onClose: () => void }) {
  if (!text) return null
  return (
    <div className="notice" role="alert">
      <span>{text}</span>
      <button className="ghost" onClick={onClose} aria-label="Dismiss">
        ✕
      </button>
    </div>
  )
}
