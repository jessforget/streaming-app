/** Pieces shared by the main window and the tablet remote. */
import type { AppState, HealthStats, Scene } from '../../shared/state'
import { renderTemplate } from '../../shared/template'

export function HealthPill({ stats }: { stats: HealthStats | null }) {
  const h = stats?.health ?? 'idle'
  return (
    <span className={`pill health-${h}`} role="status" title={stats?.message}>
      <span className="dot" />
      {stats?.message ?? 'Ready'}
    </span>
  )
}

/** A drawing of a scene: what viewers would see. Used for scene thumbnails, the tablet and the mockup; the main window shows the real video. */
export function ScenePicture({ scene, state, live, next }: { scene: Scene; state: AppState; live?: boolean; next?: boolean }) {
  const visible = scene.layers.filter((l) => l.visible)
  const video = visible.find((l) => l.kind === 'video')
  const texts = visible.filter((l) => l.kind === 'text' && l.text)
  const title = texts.find((l) => l.id.endsWith('-title'))
  const lower = texts.find((l) => l.id.endsWith('lower-third'))
  const score = texts.find((l) => l.id.endsWith('score'))
  return (
    <div className={`picture ${live ? 'is-live' : ''} ${next ? 'is-next' : ''} ${video ? 'has-camera' : ''}`}>
      {video && (
        <div className={`picture-camera ${title ? 'corner' : ''}`}>{deviceName(state, video.device) ?? video.name}</div>
      )}
      {title && <div className="picture-title">{renderTemplate(title.text!, state.data)}</div>}
      {score && <div className="picture-score">{renderTemplate(score.text!, state.data)}</div>}
      {lower && renderTemplate(lower.text!, state.data).trim() && (
        <div className="picture-lower">{renderTemplate(lower.text!, state.data)}</div>
      )}
    </div>
  )
}

/** The name of a capture or audio device, or undefined when the PC can't see it right now. */
export function deviceName(state: AppState, id: string | undefined) {
  if (!id) return undefined
  return [...state.inputs.video, ...state.inputs.audio].find((d) => d.id === id)?.name
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
