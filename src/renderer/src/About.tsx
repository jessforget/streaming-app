import { useEffect, useState } from 'react'
import about from '../../../about.json'
import type { AppState } from '../../shared/state'

/** "17 November 2026" from "2026-11-17", the same on every PC. */
export function longDate(iso: string): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const [y, m, d] = iso.split('-').map(Number)
  return y && m && d ? `${d} ${months[m - 1]} ${y}` : iso
}

/** The addresses other computers use, one row each (a port of 0 means that part is off). */
export function connectRows(state: AppState): { label: string; port: number; url: (ip: string) => string; note?: string }[] {
  const n = state.devices.network
  const rows: { label: string; port: number; url: (ip: string) => string; note?: string }[] = []
  if (n.controlPort) {
    rows.push({ label: 'Tablet remote', port: n.controlPort, url: (ip) => `http://${ip}:${n.controlPort}/remote` })
    rows.push({ label: 'Companion app, stream deck', port: n.controlPort, url: (ip) => `ws://${ip}:${n.controlPort}/ws` })
  }
  if (n.phonePort) {
    rows.push({ label: 'Phone cameras', port: n.phonePort, url: (ip) => `https://${ip}:${n.phonePort}/cam`, note: 'Scan the QR code in Settings, Video and audio inputs: it adds the phone’s pass.' })
  }
  if (n.rtmpPort) rows.push({ label: 'Cameras that stream (RTMP)', port: n.rtmpPort, url: (ip) => `rtmp://${ip}:${n.rtmpPort}/live` })
  return rows
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Older browsers or a page that isn't allowed the clipboard: select-and-copy fallback.
      const t = document.createElement('textarea')
      t.value = text
      document.body.append(t)
      t.select()
      document.execCommand('copy')
      t.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button className="small" onClick={() => void copy()} aria-label={`Copy ${text}`}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

export function About({ state, onClose }: { state: AppState; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const addresses = state.devices.network.addresses
  const [pick, setPick] = useState(0)
  const ip = addresses[Math.min(pick, addresses.length - 1)]?.ip ?? ''
  const rows = connectRows(state)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about" role="dialog" aria-label="About" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>About</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body stack">
          <div className="about-title">
            <img src="/icons/icon.svg" alt="" width={56} height={56} />
            <div>
              <strong>{about.name}</strong>
              <span className="muted">Live streaming and recording for ATEM shows</span>
            </div>
          </div>
          <dl className="about-facts">
            <dt>Version</dt>
            <dd>{about.version}</dd>
            <dt>Revision date</dt>
            <dd>{longDate(about.revisionDate)}</dd>
            <dt>Developer</dt>
            <dd>{about.developer}</dd>
            <dt>Copyright</dt>
            <dd>{about.copyright}</dd>
          </dl>
          <section>
            <h3>Connect from another computer</h3>
            <p className="muted small">Other devices must be on the same network as this PC.</p>
            {addresses.length === 0 ? (
              <p className="warn-text">This PC isn’t on a network right now. Connect to Wi-Fi or plug in a network cable; the address shows up here by itself.</p>
            ) : (
              <div className="about-ips" role="radiogroup" aria-label="This PC’s address">
                {addresses.map((a, i) => (
                  <button key={a.ip} role="radio" aria-checked={a.ip === ip} className={a.ip === ip ? 'on' : ''} onClick={() => setPick(i)}>
                    <span className="about-adapter">{a.name}</span>
                    <span className="about-ip">{a.ip}</span>
                  </button>
                ))}
              </div>
            )}
            {addresses.length > 1 && <p className="muted small">This PC has more than one address. Pick the one on the same network as the other computer (usually Wi-Fi or Ethernet).</p>}
            {ip && (
              <ul className="about-links">
                {rows.map((r) => (
                  <li key={r.label}>
                    <div>
                      <strong>{r.label}</strong>
                      <span className="muted small">port {r.port}</span>
                    </div>
                    <code>{r.url(ip)}</code>
                    <CopyButton text={r.url(ip)} />
                    {r.note && <span className="muted small about-note">{r.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
