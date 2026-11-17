import { createContext, useContext, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { AppState, Destination } from '../../shared/state'
import { MAX_DESTINATIONS, PLATFORMS, QUALITY_PRESETS, presetFor } from '../../shared/presets'
import { ROLES, ROLE_LABELS, type Role } from '../../shared/protocol'
import type { Run } from './useApp'
import { NET_PREFIX, NETCAMS_CHANGED, type NetCamConfig } from './studio/netcams'

export type SettingsTab = 'golive' | 'inputs' | 'devices'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'golive', label: 'Go Live' },
  { id: 'inputs', label: 'Video and audio inputs' },
  { id: 'devices', label: 'Remote and devices' }
]

/**
 * Fields with something typed but not saved yet. "Done" saves them all, then closes Settings.
 * Each field adds its save while it has an unsaved change.
 */
type KeyCheck = { ok: boolean; message: string }
/** Asks the app to check a platform's saved key (set by the main window). */
const TestKey = createContext<(id: string) => Promise<KeyCheck>>(async () => ({ ok: false, message: 'Not available here.' }))

const PendingSaves = createContext<Map<string, () => Promise<unknown>>>(new Map())

function usePendingSave(id: string, save: (() => Promise<unknown>) | null) {
  const pending = useContext(PendingSaves)
  useEffect(() => {
    if (save) pending.set(id, save)
    else pending.delete(id)
    return () => void pending.delete(id)
  }, [pending, id, save])
}

export function Settings(props: {
  state: AppState
  run: Run
  tab: SettingsTab
  onTab: (t: SettingsTab) => void
  onClose: () => void
  testKey?: (id: string) => Promise<KeyCheck>
  /** Asks the main window's browser for the devices again (only on the PC that runs the cameras). */
  rescan?: () => Promise<void>
}) {
  const { state, run, tab, onTab, onClose } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const pending = useRef(new Map<string, () => Promise<unknown>>()).current
  const [saving, setSaving] = useState(false)
  const done = async () => {
    setSaving(true)
    try {
      for (const save of [...pending.values()]) await save()
    } finally {
      setSaving(false)
    }
    onClose()
  }
  return (
    <PendingSaves.Provider value={pending}>
    <TestKey.Provider value={props.testKey ?? (async () => ({ ok: false, message: 'Not available here.' }))}>
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => onTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">
          {tab === 'golive' && <GoLive state={state} run={run} />}
          {tab === 'inputs' && <Inputs state={state} run={run} rescan={props.rescan} />}
          {tab === 'devices' && <Devices state={state} run={run} />}
        </div>
        <footer className="modal-foot">
          <span className="muted small">Changes are saved as you make them. Done also saves anything typed but not saved yet.</span>
          <button className="primary" disabled={saving} onClick={() => void done()}>
            {saving ? 'Saving…' : 'Done'}
          </button>
        </footer>
      </div>
    </div>
    </TestKey.Provider>
    </PendingSaves.Provider>
  )
}

/** In plain words: what frame rate the stream uses and why. */
function frameRateNote(state: AppState): string {
  const st = state.stream
  const fps = presetFor(st.quality, st.family).fps
  const busy = st.live || state.recording.active
  const pending = st.frameRate === 'auto' && st.cameras.family && st.cameras.family !== st.family
  let text: string
  if (st.frameRate !== 'auto') text = `Streaming at ${fps} fps.`
  else if (st.cameras.family === null && st.cameras.note) text = `${st.cameras.note}. Streaming at ${fps} fps; pick 25 or 30 above to choose.`
  else if (st.cameras.note) text = `Streaming at ${fps} fps to match your cameras (${st.cameras.note}).`
  else text = `Streaming at ${fps} fps. It will match your cameras once they are connected.`
  if (busy && pending) text += ' The new rate starts after you stop streaming and recording.'
  if (st.frameRate !== 'auto' && st.cameras.family && st.cameras.family !== st.frameRate && st.cameras.note) {
    text += ` Your cameras send ${st.cameras.family === 'pal' ? '25/50' : '30/60'} fps (${st.cameras.note}), so movement may look jerky.`
  }
  return text
}

function GoLive({ state, run }: { state: AppState; run: Run }) {
  const enabled = state.stream.destinations.filter((d) => d.enabled).length
  const locked = state.stream.live
  const q = state.stream.quality
  const needMbps = ((enabled * (QUALITY_PRESETS[q].videoKbps + QUALITY_PRESETS[q].audioKbps)) / 1000).toFixed(1)
  return (
    <div className="stack">
      <section>
        <h3>Where to stream</h3>
        <p className="muted">
          Turn on up to {MAX_DESTINATIONS} platforms. Streaming to more than one is optional.
          {locked && ' Stop the stream to change these.'}
        </p>
        <div className="destinations">
          {state.stream.destinations.map((d) => (
            <DestinationCard key={d.id} d={d} run={run} locked={locked} full={!d.enabled && enabled >= MAX_DESTINATIONS} />
          ))}
        </div>
      </section>
      <section>
        <h3>Quality</h3>
        <div className="segmented">
          {(['low', 'medium', 'high'] as const).map((k) => (
            <button key={k} className={q === k ? 'on' : ''} disabled={locked} onClick={() => run('settings.setQuality', { quality: k })}>
              {QUALITY_PRESETS[k].label}
              <small>{presetFor(k, state.stream.family).summary}</small>
            </button>
          ))}
        </div>
        <h4>Frame rate</h4>
        <div className="segmented">
          {(
            [
              ['auto', 'Match cameras', 'Picked from your cameras'],
              ['pal', '25 / 50 fps', 'Europe, Africa, Middle East'],
              ['ntsc', '30 / 60 fps', 'Americas, Japan']
            ] as const
          ).map(([k, label, small]) => (
            <button
              key={k}
              className={state.stream.frameRate === k ? 'on' : ''}
              disabled={locked || state.recording.active}
              onClick={() => run('settings.setFrameRate', { frameRate: k })}
            >
              {label}
              <small>{small}</small>
            </button>
          ))}
        </div>
        <p className="muted">{frameRateNote(state)}</p>
        <p className="muted">
          {enabled > 0
            ? `Needs about ${needMbps} Mbps of upload for ${enabled} platform${enabled > 1 ? 's' : ''}. The app picks the best encoder on this PC.`
            : 'Turn on a platform above.'}
        </p>
      </section>
      <section>
        <h3>Recordings</h3>
        <FolderField value={state.recording.folder} onSave={(folder) => run('settings.setRecordFolder', { folder })} />
        <p className="muted">Saved as {state.recording.format.toUpperCase()}, which survives a crash. Same quality as the stream.</p>
      </section>
    </div>
  )
}

function DestinationCard({ d, run, locked, full }: { d: Destination; run: Run; locked: boolean; full: boolean }) {
  const info = PLATFORMS[d.platform]
  const [key, setKey] = useState('')
  const savedUrl = d.serverUrl || info.ingestUrl
  const [url, setUrl] = useState(savedUrl)
  const testKey = useContext(TestKey)
  const [check, setCheck] = useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false })
  const urlChanged = url.trim() !== savedUrl
  // Typed but not saved: "Done" saves it.
  usePendingSave(
    `dest-${d.id}`,
    key || urlChanged
      ? async () => {
          if (urlChanged) await run('settings.setDestination', { id: d.id, serverUrl: url })
          if (key && (await run('settings.setDestination', { id: d.id, streamKey: key }))) setKey('')
        }
      : null
  )
  const test = async () => {
    setCheck({ busy: true })
    try {
      if (urlChanged) await run('settings.setDestination', { id: d.id, serverUrl: url })
      if (key && (await run('settings.setDestination', { id: d.id, streamKey: key }))) setKey('')
      const r = await testKey(d.id)
      setCheck({ busy: false, ...r })
    } catch {
      setCheck({ busy: false, ok: false, message: 'Could not check the key. Is the app still running?' })
    }
  }
  return (
    <div className={`destination ${d.enabled ? 'on' : ''}`}>
      <label className="destination-head">
        <span className="switch">
          <input
            type="checkbox"
            checked={d.enabled}
            disabled={locked || full}
            onChange={(e) => run('settings.setDestination', { id: d.id, enabled: e.target.checked })}
          />
          <span />
        </span>
        <strong>{info.label}</strong>
        {d.vertical && <em className="tag">Vertical</em>}
        <span className={`key-state ${d.hasKey ? 'ok' : ''}`}>{d.hasKey ? `Key saved${d.keyEnd ? ` (ends in …${d.keyEnd})` : ''}` : 'No key yet'}</span>
      </label>
      {d.enabled && (
        <div className="destination-body">
          <label className="field-label small muted">Server address</label>
          <div className="row">
            <input
              placeholder="Server address (rtmps://…)"
              value={url}
              disabled={locked}
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => urlChanged && run('settings.setDestination', { id: d.id, serverUrl: url })}
            />
            {info.ingestUrl && d.serverUrl && (
              <button
                disabled={locked}
                title={`Go back to ${info.ingestUrl}`}
                onClick={async () => {
                  if (await run('settings.setDestination', { id: d.id, serverUrl: '' })) setUrl(info.ingestUrl)
                }}
              >
                Reset
              </button>
            )}
          </div>
          <div className="row">
            <input
              type="password"
              placeholder={d.hasKey ? 'Replace stream key' : 'Paste stream key'}
              value={key}
              disabled={locked}
              autoComplete="off"
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              disabled={!key || locked}
              onClick={async () => {
                if (await run('settings.setDestination', { id: d.id, streamKey: key })) setKey('')
              }}
            >
              Save key
            </button>
            <button disabled={check.busy || (!d.hasKey && !key)} onClick={() => void test()} title="Asks the platform whether it knows this key. Nothing goes live.">
              {check.busy ? 'Checking…' : 'Test key'}
            </button>
          </div>
          {check.message && <p className={`small ${check.ok ? 'ok-text' : 'error-text'}`}>{check.ok ? '✓ ' : '✕ '}{check.message}</p>}
          {d.keyEnd && <p className="muted small">To compare: the key in {info.label}'s settings should end in …{d.keyEnd}.</p>}
          {d.platform === 'youtube' && (
            <p className="muted small">
              The address is filled in for you. It is the secure version of the rtmp://a.rtmp.youtube.com/live2 address YouTube Studio shows; both work.
            </p>
          )}
          <p className="muted small">{info.help}</p>
        </div>
      )}
    </div>
  )
}

function FolderField({ value, onSave }: { value: string; onSave: (v: string) => unknown }) {
  const [v, setV] = useState(value)
  usePendingSave('record-folder', v && v !== value ? async () => onSave(v) : null)
  return (
    <div className="row">
      <input value={v} onChange={(e) => setV(e.target.value)} aria-label="Recordings folder" />
      <button disabled={!v || v === value} onClick={() => onSave(v)}>
        Save
      </button>
    </div>
  )
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

/** "Look again": scans, shows that it is scanning (at least a moment, so it can be seen), then a Done button. */
function useScan(run: Run, rescan?: () => Promise<void>) {
  const [status, setStatus] = useState<'idle' | 'busy' | 'done'>('idle')
  const start = async () => {
    setStatus('busy')
    const minimum = new Promise((r) => setTimeout(r, 1200))
    try {
      if (rescan) await rescan()
      await run('inputs.refresh')
    } finally {
      await minimum
      setStatus('done')
    }
  }
  return { status, busy: status === 'busy', start, dismiss: () => setStatus('idle') }
}

function Inputs({ state, run, rescan }: { state: AppState; run: Run; rescan?: () => Promise<void> }) {
  const { video, audio } = state.inputs
  const scan = useScan(run, rescan)
  return (
    <div className="stack">
      <PhoneCameras state={state} />
      <NetworkCameras state={state} />
      <section>
        <h3>Video and audio coming into this PC</h3>
        <p className="muted">
          Like OBS, this app does not switch cameras. Your ATEM does that. The app takes in what the ATEM or HyperDeck sends and
          adds scenes, graphics and audio on top.
        </p>
        <ul className="muted small">
          <li>
            <strong>ATEM Mini:</strong> plug its USB-C port into this PC. Its picture shows up as a webcam and its sound as a USB
            audio input.
          </li>
          <li>
            <strong>USB audio interface (Zoom LiveTrak L-12, Focusrite Scarlett):</strong> install the maker's driver, then plug
            it in. It shows up here by its own name. Each input or pair the driver offers can have its own fader (in the web version, often just the main pair; every input separately comes with the desktop version).
          </li>
          <li>
            <strong>HyperDeck or a larger ATEM:</strong> connect its HDMI or SDI out to a capture card (Blackmagic DeckLink or
            UltraStudio, or a USB HDMI capture). The sound comes in with the picture.
          </li>
        </ul>
      </section>
      <section>
        <div className="panel-head">
          <h3>Devices this PC can see</h3>
          <button className="small" onClick={() => void scan.start()} disabled={scan.busy}>
            {scan.busy ? 'Looking…' : 'Look again'}
          </button>
        </div>
        {scan.status !== 'idle' && (
          <div className={`scan-status ${scan.busy ? 'busy' : 'done'}`} role="status" aria-live="polite">
            {scan.busy ? <span className="spinner" aria-hidden="true" /> : <span className="tick" aria-hidden="true">✓</span>}
            <span className="scan-text">
              {scan.busy
                ? 'Scanning for cameras, video and audio inputs…'
                : `Scan finished: ${count(video.length, 'video input')} and ${count(audio.length, 'audio input')} found.`}
            </span>
            {!scan.busy && (
              <button className="small" onClick={scan.dismiss}>
                Done
              </button>
            )}
          </div>
        )}
        <h4>Video</h4>
        {video.length === 0 ? (
          <p className="muted">None found. Check the cable. Devices show up here by themselves when plugged in.</p>
        ) : (
          <ul className="device-list">
            {video.map((d) => (
              <li key={d.id}>
                <span className="dot on" />
                <strong>{d.name}</strong>
              </li>
            ))}
          </ul>
        )}
        <h4>Audio</h4>
        {audio.length === 0 ? (
          <p className="muted">None found.</p>
        ) : (
          <ul className="device-list">
            {audio.map((d) => (
              <li key={d.id}>
                <span className="dot on" />
                <strong>{d.name}</strong>
                <span className="muted small">
                  {d.driver === 'asio' ? 'ASIO' : 'Windows audio'}
                  {d.channels ? `, ${d.channels} input${d.channels > 1 ? 's' : ''}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Add one to a scene with "+ Add source", or to the mixer with "+ Add audio".</p>
      </section>
    </div>
  )
}

/** Phones as cameras: scan the QR code, press Start on the phone, and it shows up as a video input. */
function PhoneCameras({ state }: { state: AppState }) {
  const [links, setLinks] = useState<string[] | null>(null)
  const [pick, setPick] = useState(0)
  const [qr, setQr] = useState('')
  useEffect(() => {
    fetch('/api/phone-link')
      .then((r) => (r.ok ? r.json() : { links: [] }))
      .then((b: { links?: string[] }) => setLinks(b.links ?? []))
      .catch(() => setLinks([]))
  }, [])
  const link = links?.[pick] ?? ''
  useEffect(() => {
    if (!link) return setQr('')
    QRCode.toString(link, { type: 'svg', margin: 1 }).then(setQr, () => setQr(''))
  }, [link])
  // Only the main window on the streaming PC gets the link (it holds the phones' secret).
  if (links === null || links.length === 0) return null
  const phones = state.inputs.video.filter((d) => d.id.startsWith('phone:'))
  return (
    <section className="pairing">
      <div className="qr" aria-label="QR code for a phone camera" dangerouslySetInnerHTML={{ __html: qr }} />
      <div>
        <h3>Phone cameras</h3>
        <p className="muted">
          Use an Android phone or an iPhone on the same Wi-Fi as a camera. Scan this code with the phone's camera, then press
          Start camera on the phone. It shows up below and in "+ Add source", like a webcam.
        </p>
        <p className="muted small">
          The first time, the phone warns that the connection isn't private, because the app made its own certificate. That's
          expected on your own network: on Android tap Advanced, then Proceed; on iPhone tap Show Details, then visit this website.
        </p>
        {links.length > 1 && (
          <p className="small">
            Network:{' '}
            <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
              {links.map((l, i) => (
                <option key={l} value={i}>
                  {new URL(l).hostname}
                </option>
              ))}
            </select>
          </p>
        )}
        <p>
          <code>{link.replace(/#.*/, '')}</code>
        </p>
        {phones.length === 0 ? (
          <p className="muted small">No phone connected yet.</p>
        ) : (
          <ul className="device-list">
            {phones.map((d) => (
              <li key={d.id}>
                <span className="dot on" />
                <strong>{d.name}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/**
 * Network cameras on the same router or Wi-Fi as this PC. Two kinds:
 * - any camera that can live stream (GoPro, Sony, DJI, a phone app...): one
 *   address for all; each camera shows up by itself while it streams;
 * - a Z CAM E2 (or another RTSP camera): type its address once.
 * Either way it shows up in "+ Add source", like a webcam.
 */
function NetworkCameras({ state }: { state: AppState }) {
  const [cams, setCams] = useState<NetCamConfig[] | null>(null)
  const [ips, setIps] = useState<string[]>([])
  const [rtmpPort, setRtmpPort] = useState(0)
  const [name, setName] = useState('Z CAM E2')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let stop = false
    const load = () =>
      fetch('/api/netcams')
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { cams?: NetCamConfig[]; ips?: string[]; rtmpPort?: number } | null) => {
          if (stop) return
          setCams(b ? (b.cams ?? []) : null)
          setIps(b?.ips ?? [])
          setRtmpPort(b?.rtmpPort ?? 0)
        })
        .catch(() => {})
    void load()
    // Streaming cameras come and go: keep the list fresh while Settings is open.
    const t = setInterval(() => void load(), 2000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [])
  // Only the main window on the streaming PC can see or change them.
  if (cams === null) return null
  const typed = cams.filter((c) => c.mode !== 'receive')
  const streaming = cams.filter((c) => c.mode === 'receive')
  const save = async (list: NetCamConfig[]) => {
    setError('')
    try {
      const r = await fetch('/api/netcams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) })
      if (!r.ok) throw new Error()
      const b = (await r.json()) as { cams: NetCamConfig[] }
      setCams(b.cams)
      window.dispatchEvent(new CustomEvent(NETCAMS_CHANGED, { detail: b.cams }))
      return true
    } catch {
      setError('Could not save. Is the app still running?')
      return false
    }
  }
  const add = async () => {
    const a = address.trim()
    if (!/^(rtsp:\/\/)?[\w.\-:@%/?=&~+]+$/i.test(a)) return setError('Type the address the camera shows, like 192.168.101.40.')
    const id = Math.random().toString(36).slice(2, 10)
    if (await save([...typed, { id, name: name.trim() || 'Network camera', mode: 'pull', address: a }])) setAddress('')
  }
  const live = new Set(state.inputs.video.filter((d) => d.id.startsWith(NET_PREFIX)).map((d) => d.id))
  const ip = ips[0] ?? 'this-pc'
  return (
    <section>
      <h3>Network cameras</h3>
      <p className="muted">
        Cameras on the same router or Wi-Fi as this PC. They show up in "+ Add source", like a webcam. The picture arrives later
        than over HDMI or USB (up to 1 to 2 seconds), so for tight cuts use a cable when you can.
      </p>

      <h4>Any camera that can live stream (GoPro, Sony, DJI, Insta360, a phone app, OBS)</h4>
      {rtmpPort ? (
        <>
          <p className="small">
            In the camera's live streaming settings, choose a custom (RTMP) server and type:
          </p>
          <p>
            Server URL <code>rtmp://{ip}:{rtmpPort}/live</code>
            <br />
            Stream key: any name, like <code>gopro</code> or <code>fx3</code>. It's the camera's name in the app.
          </p>
          <p className="muted small">
            Set the camera to H.264, 1080p, and start streaming. It shows up below by itself, no need to add it here. Give each
            camera its own stream key. The first time, Windows may ask whether to let the app use the network: click Allow.
          </p>
        </>
      ) : (
        <p className="small error-text">Cameras can't stream to the app right now: another program is using port 1935. Close it and restart the app.</p>
      )}
      {streaming.length === 0 ? (
        <p className="muted small">No camera streaming to the app right now.</p>
      ) : (
        <ul className="device-list">
          {streaming.map((c) => (
            <li key={c.id}>
              <span className={live.has(NET_PREFIX + c.id) ? 'dot on' : 'dot'} />
              <strong>{c.name}</strong> <span className="muted small">from {c.address}</span>{' '}
              {c.problem ? <span className="small error-text">{c.problem}</span> : <span className="muted small">{live.has(NET_PREFIX + c.id) ? 'Connected' : 'Starting'}</span>}
            </li>
          ))}
        </ul>
      )}

      <h4>Z CAM E2 (or another camera with an RTSP stream)</h4>
      <p className="muted small">
        Type the address the camera shows (on the E2: Menu, Connect, Network). Set its stream to H.264, 1920 × 1080. Other RTSP
        cameras need their full rtsp:// link.
      </p>
      {typed.length > 0 && (
        <ul className="device-list">
          {typed.map((c) => (
            <li key={c.id}>
              <span className={live.has(NET_PREFIX + c.id) ? 'dot on' : 'dot'} />
              <strong>{c.name}</strong> <span className="muted small">{c.address}</span>{' '}
              <span className="muted small">{live.has(NET_PREFIX + c.id) ? 'Connected' : 'Not connected yet'}</span>{' '}
              <button onClick={() => void save(typed.filter((x) => x.id !== c.id))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Camera name" placeholder="Name" />
        <input value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Camera address" placeholder="e.g. 192.168.101.40" />
        <button disabled={!address.trim()} onClick={() => void add()}>
          Add camera
        </button>
      </div>
      {error && <p className="small error-text">{error}</p>}
    </section>
  )
}

function Devices({ state, run }: { state: AppState; run: Run }) {
  const d = state.devices
  const pairUrl = d.controlUrl ? `${d.controlUrl}/remote#code=${d.pairingCode}` : ''
  const [qr, setQr] = useState('')
  useEffect(() => {
    if (!pairUrl || !d.pairingOpen) return setQr('')
    QRCode.toString(pairUrl, { type: 'svg', margin: 1 }).then(setQr, () => setQr(''))
  }, [pairUrl, d.pairingOpen])
  return (
    <div className="stack">
      <section className="pairing">
        <div className="qr" aria-label="QR code to pair a tablet" dangerouslySetInnerHTML={{ __html: qr }} />
        <div>
          <h3>Pair a tablet or device</h3>
          {d.pairingOpen ? (
            <>
              <p className="muted">Scan with the tablet's camera, or open the address below and type the code.</p>
              <p className="code">{d.pairingCode.replace(/(\d{3})(\d{3})/, '$1 $2')}</p>
              <p>
                <code>{d.controlUrl ? `${d.controlUrl}/remote` : 'Control server is not running'}</code>
              </p>
              <div className="row">
                <button onClick={() => run('devices.newPairingCode')}>New code</button>
                <button className="ghost" onClick={() => run('devices.setPairingOpen', { open: false })}>
                  Stop pairing
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">Pairing is off. Already paired devices still work.</p>
              <button onClick={() => run('devices.setPairingOpen', { open: true })}>Allow new devices</button>
            </>
          )}
          <p className="muted small">
            Companion app developers: the test page is at <code>{d.controlUrl ? `${d.controlUrl}/test` : '/test'}</code>.
          </p>
        </div>
      </section>
      <section>
        <h3>Paired devices</h3>
        {d.list.length === 0 && <p className="muted">None yet.</p>}
        <ul className="device-list">
          {d.list.map((dev) => (
            <li key={dev.id}>
              <span className={`dot ${dev.connected ? 'on' : ''}`} title={dev.connected ? 'Connected' : 'Not connected'} />
              <strong>{dev.name}</strong>
              <select value={dev.role} onChange={(e) => run('devices.setRole', { deviceId: dev.id, role: e.target.value as Role })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <button className="ghost small" onClick={() => run('devices.remove', { deviceId: dev.id })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
