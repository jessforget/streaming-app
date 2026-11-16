/** OBS-style editing in the main window: scenes, sources and audio channels. */
import { useState } from 'react'
import type { AppState, AudioKind, AudioSource, InputDevice, Layer, LayerKind, Placement, Scene } from '../../shared/state'
import { LAYER_KINDS, PLACEMENTS, PLACEMENT_LABEL, SYNC_OFFSET_RANGE, channelCount, channelName, placementOf, scenesOnAir } from '../../shared/state'
import { deviceName } from './parts'
import type { Run } from './useApp'

export const KIND_LABEL: Record<LayerKind, string> = {
  video: 'Video input',
  image: 'Image',
  text: 'Text',
  browser: 'Browser',
  media: 'Video file',
  screen: 'Screen',
  window: 'Window',
  color: 'Color',
  countdown: 'Countdown',
  slideshow: 'Slideshow',
  scene: 'Scene'
}

const KIND_HELP: Record<LayerKind, string> = {
  video: 'The ATEM Mini, a HyperDeck through a capture card, or any camera',
  image: 'A picture or logo from a file',
  text: 'Words on screen. {field} shows data from the companion app',
  browser: 'A web page, such as an alerts overlay (needs the desktop version: the web version can’t draw web pages into the video)',
  media: 'A video file, such as an intro or a promo. It can loop, and its sound can play while its scene is on air',
  screen: 'Everything on one of this PC’s screens',
  window: 'One app window on this PC',
  color: 'A solid color, as a background or a box behind text',
  countdown: 'Counts down to a time (like 19:30) or for some minutes after the scene goes on air',
  slideshow: 'Every picture in a folder, one after another',
  scene: 'Another scene shown inside this one, such as a logo-and-title scene used on every slide'
}

const AUDIO_KIND_LABEL: Record<AudioKind, string> = {
  file: 'Music or sound file (background music, loops)',
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
      <button
        className="ghost small"
        disabled={onAir && !scene.stored}
        onClick={() => run('scene.store', { sceneId: scene.id, stored: !scene.stored })}
        title={
          scene.stored
            ? `Bring ${scene.name} back into this show`
            : onAir
              ? 'This scene is on air'
              : `Put ${scene.name} away in the Scene library. Nothing is deleted.`
        }
      >
        {scene.stored ? '↑ Use in this show' : '↓ Put in library'}
      </button>
    </div>
  )
}

/** The source list for one scene, like OBS's Sources panel. */
export function SourceList({ state, run, scene }: { state: AppState; run: Run; scene: Scene }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div className="layers">
      <div className="panel-head">
        <h2>Sources in {scene.name}</h2>
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
  if (layer.kind === 'scene') {
    const inner = state.scenes.find((x) => x.id === layer.sceneId)
    return <span className={`layer-text ${inner ? '' : 'warn-text'}`}>{`${kind} · ${inner?.name ?? 'scene not found'}`}</span>
  }
  const extra =
    layer.kind === 'countdown'
      ? layer.until
        ? `to ${layer.until}`
        : `${layer.minutes ?? 5} min`
      : layer.kind === 'color'
        ? layer.color
        : layer.kind === 'media'
          ? `${layer.url ?? ''}${layer.loop === false ? ' · plays once' : ' · loops'}${layer.sound ? ' · with sound' : ''}`
          : (layer.text ?? layer.url)
  return <span className="layer-text">{extra ? `${kind} · ${extra}` : kind}</span>
}

/** Fields shared by "Add source" and "Edit". */
function SourceFields(props: { state: AppState; kind: LayerKind; scene: Scene; v: Fields; set: SetField }) {
  const { state, kind, scene, v, set } = props
  // A scene can show any other scene that doesn't already show this one.
  const nestable = state.scenes.filter((x) => x.id !== scene.id && !scenesOnAir(state, x.id).has(scene.id))
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
      {(kind === 'image' || kind === 'media' || kind === 'browser' || kind === 'slideshow') && (
        <label>
          {kind === 'browser' ? 'Web address' : kind === 'slideshow' ? 'Folder with the pictures' : 'File'}
          <input
            value={v.url}
            placeholder={kind === 'browser' ? 'https://…' : kind === 'slideshow' ? 'C:\\Pictures\\Sponsors' : kind === 'media' ? 'C:\\Videos\\intro.mp4' : 'C:\\Pictures\\logo.png'}
            onChange={(e) => set('url', e.target.value)}
          />
          <small className="muted">Right-click the file in File Explorer, then "Copy as path", and paste it here.</small>
        </label>
      )}
      {kind === 'media' && (
        <>
          <label className="check">
            <input type="checkbox" checked={v.loop} onChange={(e) => set('loop', e.target.checked)} /> Loop (otherwise it plays once, from the start, each time its scene goes on air)
          </label>
          <label className="check">
            <input type="checkbox" checked={v.sound} onChange={(e) => set('sound', e.target.checked)} /> Play its sound while this scene is on air
          </label>
          {v.sound && (
            <label>
              Volume
              <input type="range" min={0} max={100} value={v.volume} onChange={(e) => set('volume', e.target.value)} />
            </label>
          )}
        </>
      )}
      {kind === 'slideshow' && (
        <label>
          Seconds per picture
          <input type="number" min={1} max={3600} value={v.seconds} onChange={(e) => set('seconds', e.target.value)} />
        </label>
      )}
      {kind === 'color' && (
        <label>
          Color
          <input type="color" value={v.color} onChange={(e) => set('color', e.target.value)} />
        </label>
      )}
      {kind === 'countdown' && (
        <>
          <label>
            Count down
            <select value={v.countMode} onChange={(e) => set('countMode', e.target.value)}>
              <option value="minutes">For some minutes, from when this scene goes on air</option>
              <option value="until">To a time of day</option>
            </select>
          </label>
          {v.countMode === 'until' ? (
            <label>
              Time
              <input type="time" value={v.until} onChange={(e) => set('until', e.target.value)} />
            </label>
          ) : (
            <label>
              Minutes
              <input type="number" min={0} max={1440} value={v.minutes} onChange={(e) => set('minutes', e.target.value)} />
            </label>
          )}
          <label>
            Text
            <input value={v.text} maxLength={200} placeholder="Starting in {time}" onChange={(e) => set('text', e.target.value)} />
            <small className="muted">{'{time}'} is where the minutes and seconds go.</small>
          </label>
        </>
      )}
      {kind === 'scene' && (
        <label>
          Scene to show
          <select value={v.showScene} onChange={(e) => set('showScene', e.target.value)}>
            <option value="">Pick a scene…</option>
            {nestable.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
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
  loop: boolean
  sound: boolean
  /** 0 to 100 */
  volume: string
  color: string
  countMode: 'minutes' | 'until'
  until: string
  minutes: string
  seconds: string
  showScene: string
}
type SetField = <K extends keyof Fields>(k: K, value: Fields[K] | string | boolean) => void

function useFields(layer: Partial<Layer> & { placement: Placement }) {
  const [v, setV] = useState<Fields>({
    name: layer.name ?? '',
    device: layer.device ?? '',
    text: layer.text ?? '',
    url: layer.url ?? '',
    placement: layer.placement,
    loop: layer.loop !== false,
    sound: layer.sound === true,
    volume: String(Math.round((layer.volume ?? 1) * 100)),
    color: layer.color ?? '#1e3a8a',
    countMode: layer.until ? 'until' : 'minutes',
    until: layer.until ?? '19:30',
    minutes: String(layer.minutes ?? 5),
    seconds: String(layer.seconds ?? 5),
    showScene: layer.sceneId ?? ''
  })
  // "Copy as path" in File Explorer adds quotes.
  const set: SetField = (k, value) => setV((old) => ({ ...old, [k]: k === 'url' && typeof value === 'string' ? value.replace(/^\s*"|"\s*$/g, '') : value }))
  return [v, set] as const
}

/** The fields a source of this kind sends with layer.add and layer.update. */
function kindFields(kind: LayerKind, v: Fields) {
  switch (kind) {
    case 'video':
      return { device: v.device }
    case 'text':
      return { text: v.text }
    case 'image':
    case 'browser':
      return v.url ? { url: v.url } : {}
    case 'media':
      return { ...(v.url && { url: v.url }), loop: v.loop, sound: v.sound, volume: Math.min(1, Math.max(0, Number(v.volume) / 100 || 0)) }
    case 'slideshow':
      return { ...(v.url && { url: v.url }), seconds: Math.max(1, Number(v.seconds) || 5) }
    case 'color':
      return { color: v.color }
    case 'countdown':
      return {
        text: v.text || 'Starting in {time}',
        ...(v.countMode === 'until' ? { until: v.until } : { until: '', minutes: Math.max(0, Number(v.minutes) || 0) })
      }
    case 'scene':
      return v.showScene ? { showScene: v.showScene } : {}
    default:
      return {}
  }
}

function AddSourceForm({ state, run, scene, onDone }: { state: AppState; run: Run; scene: Scene; onDone: () => void }) {
  const [kind, setKind] = useState<LayerKind>('video')
  const [v, set] = useFields({ device: state.inputs.video[0]?.id, placement: 'full' })
  const pick = (k: LayerKind) => {
    setKind(k)
    set('placement', k === 'text' ? 'lower-third' : k === 'countdown' ? 'center' : 'full')
  }
  const needsDevice = (kind === 'video' && !v.device) || (kind === 'scene' && !v.showScene)
  const add = async () => {
    const ok = await run('layer.add', {
      sceneId: scene.id,
      kind,
      ...(v.name.trim() && { name: v.name.trim() }),
      ...kindFields(kind, v),
      placement: v.placement
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
      <SourceFields state={state} kind={kind} scene={scene} v={v} set={set} />
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
    const fields: Record<string, unknown> = kindFields(layer.kind, v)
    if (layer.kind === 'video' && (!v.device || v.device === layer.device)) delete fields.device
    if (layer.kind === 'scene' && v.showScene === layer.sceneId) delete fields.showScene
    const ok = await run('layer.update', {
      sceneId: scene.id,
      layerId: layer.id,
      ...(v.name.trim() && v.name.trim() !== layer.name && { name: v.name.trim() }),
      ...fields,
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
      <SourceFields state={state} kind={layer.kind} scene={scene} v={v} set={set} />
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

/**
 * Which scenes a sound plays in. Sound follows the scene: it is heard only
 * while one of its scenes is on air, unless it is set to every scene.
 */
function ScenePicker({ state, value, onChange }: { state: AppState; value: string[] | undefined; onChange: (v: string[] | undefined) => void }) {
  const all = value === undefined
  const toggle = (id: string, on: boolean) => {
    const next = new Set(value ?? [])
    if (on) next.add(id)
    else next.delete(id)
    onChange(state.scenes.map((x) => x.id).filter((x) => next.has(x)))
  }
  return (
    <fieldset className="scene-picker">
      <legend>Plays in</legend>
      <label className="check">
        <input type="radio" checked={all} onChange={() => onChange(undefined)} /> Every scene (like a presenter's mic)
      </label>
      <label className="check">
        <input type="radio" checked={!all} onChange={() => onChange([state.previewSceneId])} /> Only these scenes:
      </label>
      {!all && (
        <div className="scene-checks">
          {state.scenes.map((x) => (
            <label key={x.id} className="check">
              <input type="checkbox" checked={value.includes(x.id)} onChange={(e) => toggle(x.id, e.target.checked)} /> {x.name}
            </label>
          ))}
        </div>
      )}
      {!all && value.length === 0 && <small className="warn-text">Pick at least one scene, or it won't be heard.</small>}
    </fieldset>
  )
}

/** File path field for a music or sound file. */
function MusicFields(props: { url: string; setUrl: (v: string) => void; loop: boolean; setLoop: (v: boolean) => void }) {
  return (
    <>
      <label>
        File
        <input value={props.url} placeholder="C:\\Music\\holding.mp3" onChange={(e) => props.setUrl(e.target.value)} />
        <small className="muted">MP3, WAV, M4A, OGG or FLAC. Right-click it in File Explorer, "Copy as path", and paste it here.</small>
      </label>
      <label className="check">
        <input type="checkbox" checked={props.loop} onChange={(e) => props.setLoop(e.target.checked)} /> Loop. It starts from the
        beginning each time its scene goes on air.
      </label>
    </>
  )
}

const fileName = (path: string) => path.replace(/^"|"$/g, '').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? ''

/** "+ Add audio": a mic, a USB audio interface (Zoom L-12, Focusrite), the ATEM Mini's USB audio, a capture card's sound, or desktop sound. */
export function AddAudioForm({ state, run, onDone }: { state: AppState; run: Run; onDone: () => void }) {
  const [kind, setKind] = useState<AudioKind>('device')
  const [scenes, setScenes] = useState<string[] | undefined>([state.previewSceneId])
  const [url, setUrl] = useState('')
  const [loop, setLoop] = useState(true)
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
      : kind === 'file'
        ? fileName(url)
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
      ...((kind === 'device' || kind === 'video') && { device }),
      ...(chs && { channels: chs }),
      ...(kind === 'file' && { url: url.replace(/^"|"$/g, ''), loop }),
      ...(scenes && { scenes })
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
        syncOffsetMs: syncMs,
        ...(scenes && { scenes })
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
      {kind === 'file' && <MusicFields url={url} setUrl={setUrl} loop={loop} setLoop={setLoop} />}
      {(kind === 'device' || kind === 'video') && (
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
      <ScenePicker state={state} value={scenes} onChange={setScenes} />
      {kind !== 'file' && <SyncField value={sync} onChange={setSync} />}
      <div className="row">
        <button
          type="submit"
          className="accent small"
          disabled={
            ((kind === 'device' || kind === 'video') && !picked) || (kind === 'file' && !url.trim()) || !(name.trim() || autoName) || scenes?.length === 0
          }
        >
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
  const [scenes, setScenes] = useState<string[] | undefined>(source.scenes)
  const [url, setUrl] = useState(source.url ?? '')
  const [loop, setLoop] = useState(source.loop !== false)
  const save = async () => {
    const chs = parseChannels(channels)
    const ok = await run('audio.update', {
      sourceId: source.id,
      ...(name.trim() && name.trim() !== source.name && { name: name.trim() }),
      ...(device && device !== source.device && { device }),
      ...(options.length > 0 && chs && channels !== (source.channels?.join(',') ?? '') && { channels: chs }),
      ...(source.kind === 'file' && { url: url.replace(/^"|"$/g, ''), loop }),
      scenes: scenes ?? [],
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
      {source.kind === 'file' && <MusicFields url={url} setUrl={setUrl} loop={loop} setLoop={setLoop} />}
      {(source.kind === 'device' || source.kind === 'video') && (
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
      <ScenePicker state={state} value={scenes} onChange={setScenes} />
      {source.kind !== 'file' && <SyncField value={sync} onChange={setSync} />}
      <div className="row">
        <button type="submit" className="accent small" disabled={(source.kind === 'file' && !url.trim()) || scenes?.length === 0}>
          Save
        </button>
        <button type="button" className="ghost small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
