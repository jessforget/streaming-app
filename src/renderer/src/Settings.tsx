import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { AppState, Destination } from '../../shared/state'
import { MAX_DESTINATIONS, PLATFORMS, QUALITY_PRESETS } from '../../shared/presets'
import { ROLES, ROLE_LABELS, type Role } from '../../shared/protocol'
import type { Run } from './useApp'

export type SettingsTab = 'golive' | 'inputs' | 'devices'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'golive', label: 'Go Live' },
  { id: 'inputs', label: 'Video and audio inputs' },
  { id: 'devices', label: 'Remote and devices' }
]

export function Settings(props: { state: AppState; run: Run; tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void }) {
  const { state, run, tab, onTab, onClose } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
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
          {tab === 'inputs' && <Inputs state={state} run={run} />}
          {tab === 'devices' && <Devices state={state} run={run} />}
        </div>
      </div>
    </div>
  )
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
              <small>{QUALITY_PRESETS[k].summary}</small>
            </button>
          ))}
        </div>
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
  const [url, setUrl] = useState(d.serverUrl ?? '')
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
        <span className={`key-state ${d.hasKey ? 'ok' : ''}`}>{d.hasKey ? 'Key saved' : 'No key yet'}</span>
      </label>
      {d.enabled && (
        <div className="destination-body">
          {info.needsServerUrl && (
            <input
              placeholder="Server address (rtmps://…)"
              value={url}
              disabled={locked}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => url !== (d.serverUrl ?? '') && run('settings.setDestination', { id: d.id, serverUrl: url })}
            />
          )}
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
          </div>
          <p className="muted small">{info.help}</p>
        </div>
      )}
    </div>
  )
}

function FolderField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <div className="row">
      <input value={v} onChange={(e) => setV(e.target.value)} aria-label="Recordings folder" />
      <button disabled={!v || v === value} onClick={() => onSave(v)}>
        Save
      </button>
    </div>
  )
}

function Inputs({ state, run }: { state: AppState; run: Run }) {
  const { video, audio } = state.inputs
  return (
    <div className="stack">
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
            <strong>HyperDeck or a larger ATEM:</strong> connect its HDMI or SDI out to a capture card (Blackmagic DeckLink or
            UltraStudio, or a USB HDMI capture). The sound comes in with the picture.
          </li>
        </ul>
      </section>
      <section>
        <div className="panel-head">
          <h3>Devices this PC can see</h3>
          <button className="small" onClick={() => run('inputs.refresh')}>
            Look again
          </button>
        </div>
        <h4>Video</h4>
        {video.length === 0 ? (
          <p className="muted">None found. Check the cable, then press Look again.</p>
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
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Add one to a scene with "+ Add source", or to the mixer with "+ Add audio".</p>
      </section>
    </div>
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
