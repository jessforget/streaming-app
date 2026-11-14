/** OBS-style editing in the main window: scenes, sources and audio channels. */
import { useState, type ReactNode } from 'react'
import type { AppState, AudioKind, AudioSource, InputDevice, Layer, LayerKind, Placement, Scene } from '../../shared/state'
import { LAYER_KINDS, PLACEMENTS, PLACEMENT_LABEL, SYNC_OFFSET_RANGE, channelCount, channelName, placementOf } from '../../shared/state'
import { deviceName } from './parts'
import type { Run } from './useApp'

export const KIND_LABEL: Record<LayerKind, string> = {
  video: 'Video input',
  image: 'Image',
  text: 'Text',
  browser: 'Browser',
  media: 'Media file',
  screen: 'Screen',
  window: 'Window'
}

const KIND_HELP: Record<LayerKind, string> = {
  video: 'The ATEM Mini, a HyperDeck through a capture card, or any camera',
  image: 'A picture or logo from a file',
  text: 'Words on screen. {field} shows data from the companion app',
  browser: 'A web page, such as an alerts overlay (needs the desktop version: the web version can’t draw web pages into the video)',
  media: 'A video or sound file',
  screen: 'Everything on one of this PC’s screens',
  window: 'One app window on this PC'
}

const AUDIO_KIND_LABEL: Record<AudioKind, string> = {
  device: 'Audio input (mic, USB interface like Zoom L-12 or Focusrite, ATEM Mini USB audio)',
  video: 'Sound from a video input (HyperDeck, capture card)',
  desktop: 'Desktop sound (this PC)'
}

/** Add, rename and remove scenes. Acts on the scene queued in Preview. */
export function SceneTools({ state, run, scene }: { state: AppState; run: Run; scene: Scene }) {
  const [mode, setMode] = useState<'none' | 'add' | 'rename'>('none')
  const [text, setText] = useState('')
  const onAir = scene.id === state.programSceneId
  const close = () => {
    setMode('none')
    setText('')
  }
  if (mode !== 'none') {
    const submit = async () => {
      const ok =
        mode === 'add' ? await run('scene.add', { name: text.trim() }) : await run('scene.rename', { sceneId: scene.id, name: text.trim() })
      if (ok) close()
    }
    return (
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          autoFocus
          value={text}
          maxLength={60}
          placeholder={mode === 'add' ? 'New scene name' : 'Scene name'}
          aria-label={mode === 'add' ? 'New scene name' : 'Scene name'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && close()}
        />
        <button type="submit" className="accent small" disabled={!text.trim()}>
          {mode === 'add' ? 'Add' : 'Save'}
        </button>
        <button type="button" className="ghost small" onClick={close}>
          Cancel
        </button>
      </form>
    )
  }
  return (
    <div className="tool-row">
      <button className="small" onClick={() => setMode('add')}>
        + Add scene
      </button>
      <button
        className="ghost small"
        onClick={() => {
          setText(scene.name)
          setMode('rename')
        }}
        title={`Rename ${scene.name}`}
      >
        Rename
      </button>
      <button
        className="ghost small"
        disabled={onAir || state.scenes.length === 1}
        onClick={() => run('scene.remove', { sceneId: scene.id })}
        title={onAir ? 'This scene is on air' : `Remove ${scene.name}`}
      >
        Remove
      </button>
    </div>
  )
}

/** The source list for one scene, like OBS's Sources panel. */
export function SourceList({ state, run, scene, picker }: { state: AppState; run: Run; scene: Scene; picker?: ReactNode }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div className="layers">
      <div className="panel-head">
        {picker ?? <h2>Sources in {scene.name}</h2>}
        {!adding && (
          <button className="small" onClick={() => setAdding(true)}>
            + Add
          </button>
        )}
      </div>
      {adding && <AddSourceForm state={state} run={run} scene={scene} onDone={() => setAdding(false)} />}
      {scene.layers.length === 0 && !adding && <p className="muted">No sources yet. Add the ATEM or HyperDeck as a video input.</p>}
      <ul>
        {scene.layers.map((l, i) => (
          <li key={l.id} className={l.visible ? '' : 'hidden-layer'}>
            <div className="layer-row">
              <label className="switch" title={l.visible ? 'Hide' : 'Show'}>
                <input
                  type="checkbox"
                  checked={l.visible}
                  aria-label={`Show ${l.name}`}
                  onChange={(e) => run('layer.setVisible', { sceneId: scene.id, layerId: l.id, visible: e.target.checked })}
                />
                <span />
              </label>
              <span className="layer-name">{l.name}</span>
              <LayerDetail state={state} layer={l} />
              <span className="layer-tools">
                <button
                  className="ghost icon"
                  disabled={i === 0}
                  aria-label={`Move ${l.name} up`}
                  title="Move up (in front)"
                  onClick={() => run('layer.move', { sceneId: scene.id, layerId: l.id, direction: 'up' })}
                >
                  ↑
                </button>
                <button
                  className="ghost icon"
                  disabled={i === scene.layers.length - 1}
                  aria-label={`Move ${l.name} down`}
                  title="Move down (behind)"
                  onClick={() => run('layer.move', { sceneId: scene.id, layerId: l.id, direction: 'down' })}
                >
                  ↓
                </button>
                <button
                  className="ghost icon"
                  aria-label={`Edit ${l.name}`}
                  title="Edit"
                  onClick={() => setEditing(editing === l.id ? null : l.id)}
                >
                  ✎
                </button>
                <button
                  className="ghost icon"
                  aria-label={`Remove ${l.name}`}
                  title="Remove"
                  onClick={() => run('layer.remove', { sceneId: scene.id, layerId: l.id })}
                >
                  ✕
                </button>
              </span>
            </div>
            {editing === l.id && (
              <SourceEditor state={state} run={run} scene={scene} layer={l} onDone={() => setEditing(null)} />
            )}
          </li>
        ))}
      </ul>
      <p className="hint">Top of the list shows in front. Text in braces, like {'{guest.name}'}, comes from the companion app.</p>
    </div>
  )
}

function LayerDetail({ state, layer }: { state: AppState; layer: Layer }) {
  const kind = KIND_LABEL[layer.kind]
  if (layer.kind === 'video') {
    const name = deviceName(state, layer.device)
    return <span className={`layer-text ${name ? '' : 'warn-text'}`}>{`${kind} · ${name ?? 'device not found'}`}</span>
  }
  const extra = layer.text ?? layer.url
  return <span className="layer-text">{extra ? `${kind} · ${extra}` : kind}</span>
}

/** Fields shared by "Add source" and "Edit". */
function SourceFields(props: {
  state: AppState
  kind: LayerKind
  v: Fields
  set: (k: keyof Fields, value: string) => void
}) {
  const { state, kind, v, set } = props
  return (
    <>
      <label>
        Name
        <input value={v.name} maxLength={60} placeholder="Optional" onChange={(e) => set('name', e.target.value)} />
      </label>
      {kind === 'video' && (
        <label>
          Device
          <select value={v.device} onChange={(e) => set('device', e.target.value)}>
            <option value="">Pick a device…</option>
            {state.inputs.video.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'text' && (
        <label>
          Text
          <input value={v.text} maxLength={500} placeholder="e.g. {guest.name}" onChange={(e) => set('text', e.target.value)} />
        </label>
      )}
      {(kind === 'image' || kind === 'media' || kind === 'browser') && (
        <label>
          {kind === 'browser' ? 'Web address' : 'File'}
          <input
            value={v.url}
            placeholder={kind === 'browser' ? 'https://…' : 'C:\\Videos\\intro.mp4'}
            onChange={(e) => set('url', e.target.value)}
          />
        </label>
      )}
      <label>
        Where
        <select value={v.placement} onChange={(e) => set('placement', e.target.value)}>
          {PLACEMENTS.map((p) => (
            <option key={p} value={p}>
              {PLACEMENT_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}

interface Fields {
  name: string
  device: string
  text: string
  url: string
  placement: Placement
}

function useFields(init: { name?: string; device?: string; text?: string; url?: string; placement: Placement }) {
  const [v, setV] = useState<Fields>({ name: init.name ?? '', device: init.device ?? '', text: init.text ?? '', url: init.url ?? '', placement: init.placement })
  return [v, (k: keyof Fields, value: string) => setV((old) => ({ ...old, [k]: value }))] as const
}

function AddSourceForm({ state, run, scene, onDone }: { state: AppState; run: Run; scene: Scene; onDone: () => void }) {
  const [kind, setKind] = useState<LayerKind>('video')
  const [v, set] = useFields({ device: state.inputs.video[0]?.id, placement: 'full' })
  const pick = (k: LayerKind) => {
    setKind(k)
    set('placement', k === 'text' ? 'lower-third' : 'full')
  }
  const needsDevice = kind === 'video' && !v.device
  const add = async () => {
    const ok = await run('layer.add', {
      sceneId: scene.id,
      kind,
      ...(v.name.trim() && { name: v.name.trim() }),
      ...(kind === 'video' && { device: v.device }),
      ...(kind === 'text' && { text: v.text }),
      ...((kind === 'image' || kind === 'media' || kind === 'browser') && v.url && { url: v.url }),
      placement: v.placement,
      // A camera goes behind the titles and graphics already in the scene.
      ...(kind === 'video' && { at: 'bottom' as const })
    })
    if (ok) onDone()
  }
  return (
    <form
      className="source-form"
      onSubmit={(e) => {
        e.preventDefault()
        add()
      }}
    >
      <div className="kind-picker" role="radiogroup" aria-label="Source type">
        {LAYER_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            className={kind === k ? 'on' : ''}
            onClick={() => pick(k)}
            title={KIND_HELP[k]}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <p className="muted small">{KIND_HELP[kind]}.</p>
      <SourceFields state={state} kind={kind} v={v} set={set} />
      {kind === 'video' && state.inputs.video.length === 0 && (
        <p className="muted small">No video devices found. Plug in the ATEM or capture card, then use Settings, Video and audio inputs.</p>
      )}
      <div className="row">
        <button type="submit" className="accent small" disabled={needsDevice}>
          Add to {scene.name}
        </button>
        <button type="button" className="ghost small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function SourceEditor(props: { state: AppState; run: Run; scene: Scene; layer: Layer; onDone: () => void }) {
  const { state, run, scene, layer, onDone } = props
  const [v, set] = useFields({ ...layer, placement: placementOf(layer) })
  const save = async () => {
    const ok = await run('layer.update', {
      sceneId: scene.id,
      layerId: layer.id,
      ...(v.name.trim() && v.name.trim() !== layer.name && { name: v.name.trim() }),
      ...(layer.kind === 'video' && v.device && v.device !== layer.device && { device: v.device }),
      ...(layer.kind === 'text' && v.text !== (layer.text ?? '') && { text: v.text }),
      ...(v.url !== (layer.url ?? '') && { url: v.url }),
      ...(v.placement !== placementOf(layer) && { placement: v.placement })
    })
    if (ok) onDone()
  }
  return (
    <form
      className="source-form"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <SourceFields state={state} kind={layer.kind} v={v} set={set} />
      <div className="row">
        <button type="submit" className="accent small">
          Save
        </button>
        <button type="button" className="ghost small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Channel choices for a device: each stereo pair, then each single input, named the way the driver names them. */
function channelOptions(d: InputDevice | undefined): { value: string; label: string }[] {
  const n = channelCount(d)
  if (n <= 2) return []
  const out: { value: string; label: string }[] = []
  for (let c = 1; c < n; c += 2) out.push({ value: `${c},${c + 1}`, label: `${c}+${c + 1} stereo: ${channelName(d, c)}, ${channelName(d, c + 1)}` })
  for (let c = 1; c <= n; c++) out.push({ value: `${c}`, label: `${c} mono: ${channelName(d, c)}` })
  return out
}

const parseChannels = (v: string) => (v ? v.split(',').map(Number) : undefined)
const shortName = (d: InputDevice | undefined) => (d?.name ?? '').replace(/\s*\((ASIO|USB.*?)\)$/i, '').replace(/^Focusrite USB ASIO/, 'Focusrite')

/** Sync offset field, in milliseconds. */
function SyncField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label>
      Sync offset (ms)
      <input
        type="number"
        inputMode="numeric"
        step={10}
        min={SYNC_OFFSET_RANGE.min}
        max={SYNC_OFFSET_RANGE.max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <small className="muted">Delay this sound to match the ATEM video. Clap on camera and adjust until it lines up; often 0 to 150.</small>
    </label>
  )
}

/** "+ Add audio": a mic, a USB audio interface (Zoom L-12, Focusrite), the ATEM Mini's USB audio, a capture card's sound, or desktop sound. */
export function AddAudioForm({ state, run, onDone }: { state: AppState; run: Run; onDone: () => void }) {
  const [kind, setKind] = useState<AudioKind>('device')
  const list = kind === 'video' ? state.inputs.video : kind === 'device' ? state.inputs.audio : []
  const [device, setDevice] = useState(state.inputs.audio[0]?.id ?? '')
  const [channels, setChannels] = useState('')
  const [name, setName] = useState('')
  const [sync, setSync] = useState('0')
  const picked = list.find((d) => d.id === device)
  const options = kind === 'device' ? channelOptions(picked) : []
  const chs = parseChannels(channels)
  const autoName =
    kind === 'desktop'
      ? 'Desktop'
      : picked
        ? chs
          ? `${shortName(picked)} ${chs.map((c) => channelName(picked, c)).join(' + ')}`
          : shortName(picked)
        : ''
  const syncMs = Number(sync) || 0
  const add = async () => {
    const ok = await run('audio.add', {
      name: (name.trim() || autoName).slice(0, 60),
      kind,
      syncOffsetMs: syncMs,
      ...(kind !== 'desktop' && { device }),
      ...(chs && { channels: chs })
    })
    if (ok) onDone()
  }
  /** One mixer channel per input, like a mixing desk. */
  const addEach = async () => {
    for (let c = 1; c <= channelCount(picked); c++) {
      const ok = await run('audio.add', {
        name: `${shortName(picked)} ${channelName(picked, c)}`.slice(0, 60),
        kind,
        device,
        channels: [c],
        syncOffsetMs: syncMs
      })
      if (!ok) return
    }
    onDone()
  }
  return (
    <form
      className="source-form"
      onSubmit={(e) => {
        e.preventDefault()
        add()
      }}
    >
      <label>
        Type
        <select
          value={kind}
          onChange={(e) => {
            const k = e.target.value as AudioKind
            setKind(k)
            setChannels('')
            setDevice((k === 'video' ? state.inputs.video : state.inputs.audio)[0]?.id ?? '')
          }}
        >
          {(Object.keys(AUDIO_KIND_LABEL) as AudioKind[]).map((k) => (
            <option key={k} value={k}>
              {AUDIO_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      {kind !== 'desktop' && (
        <label>
          Device
          <select
            value={device}
            onChange={(e) => {
              setDevice(e.target.value)
              setChannels('')
            }}
          >
            <option value="">Pick a device…</option>
            {list.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {options.length > 0 && (
        <label>
          Channels on {shortName(picked)}
          <select value={channels} onChange={(e) => setChannels(e.target.value)}>
            <option value="">1+2 (the first pair)</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Name
        <input value={name} maxLength={60} placeholder={autoName || 'Channel name'} onChange={(e) => setName(e.target.value)} />
      </label>
      <SyncField value={sync} onChange={setSync} />
      <div className="row">
        <button type="submit" className="accent small" disabled={(kind !== 'desktop' && !picked) || !(name.trim() || autoName)}>
          Add channel
        </button>
        {options.length > 0 && (
          <button type="button" className="small" onClick={addEach} title="Adds one mixer channel for every input, like a mixing desk">
            Add all {channelCount(picked)} inputs
          </button>
        )}
        <button type="button" className="ghost small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Edit a mixer channel: name, which inputs, sync offset. */
export function AudioEditor({ state, run, source, onDone }: { state: AppState; run: Run; source: AudioSource; onDone: () => void }) {
  const [device, setDevice] = useState(source.device ?? '')
  const dev = state.inputs.audio.find((d) => d.id === device)
  const options = source.kind === 'device' ? channelOptions(dev) : []
  const devices = source.kind === 'video' ? state.inputs.video : state.inputs.audio
  const [name, setName] = useState(source.name)
  const [channels, setChannels] = useState(source.channels?.join(',') ?? '')
  const [sync, setSync] = useState(String(source.syncOffsetMs ?? 0))
  const save = async () => {
    const chs = parseChannels(channels)
    const ok = await run('audio.update', {
      sourceId: source.id,
      ...(name.trim() && name.trim() !== source.name && { name: name.trim() }),
      ...(device && device !== source.device && { device }),
      ...(options.length > 0 && chs && channels !== (source.channels?.join(',') ?? '') && { channels: chs }),
      syncOffsetMs: Number(sync) || 0
    })
    if (ok) onDone()
  }
  return (
    <form
      className="source-form"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <strong>{source.name}</strong>
      {source.kind === 'desktop' && <span className="muted small">Desktop sound</span>}
      <label>
        Name
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      {source.kind !== 'desktop' && (
        <label>
          Device
          <select
            value={device}
            onChange={(e) => {
              setDevice(e.target.value)
              setChannels('')
            }}
          >
            {!devices.some((d) => d.id === device) && (
              <option value={device}>{device ? 'Device not plugged in' : source.kind === 'device' ? 'Windows default mic' : 'Pick a device…'}</option>
            )}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {options.length > 0 && (
        <label>
          Channels
          <select value={channels} onChange={(e) => setChannels(e.target.value)}>
            {!source.channels && <option value="">1+2 (the first pair)</option>}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <SyncField value={sync} onChange={setSync} />
      <div className="row">
        <button type="submit" className="accent small">
          Save
        </button>
        <button type="button" className="ghost small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
