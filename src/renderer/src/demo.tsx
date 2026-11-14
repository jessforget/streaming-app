/**
 * Interactive mockup: the real screens, running in a browser with simulated
 * cameras and engine. The main window, the tablet and a pretend companion
 * app all share one app, so a tap on the tablet shows up in the main window.
 */
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DemoApp } from './bridge/demoBridge'
import { MainWindow } from './MainWindow'
import { RemoteScreen } from './Remote'
import './styles.css'

type View = 'main' | 'tablet' | 'companion'

function Demo() {
  const app = useMemo(() => new DemoApp(), [])
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<View>(() => (window.innerWidth < 900 ? 'tablet' : 'main'))
  useEffect(() => {
    app.start().then(() => setReady(true))
  }, [app])
  const mainBridge = useMemo(() => app.bridge('local'), [app])
  const tabletBridge = useMemo(() => app.bridge('remote', 'remote'), [app])
  if (!ready) return <div className="loading">Starting the mockup…</div>
  return (
    <div className="demo">
      <header className="demo-bar">
        <div>
          <strong>Streaming App: interactive mockup</strong>
          <span className="muted"> Pretend ATEM Mini and HyperDeck inputs. Nothing is captured or sent.</span>
        </div>
        <nav className="tabs">
          <button className={view === 'main' ? 'on' : ''} onClick={() => setView('main')}>
            Main window
          </button>
          <button className={view === 'tablet' ? 'on' : ''} onClick={() => setView('tablet')}>
            Tablet remote
          </button>
          <button className={view === 'companion' ? 'on' : ''} onClick={() => setView('companion')}>
            Companion app
          </button>
        </nav>
      </header>
      <div className="demo-stage">
        {view === 'main' && (
          <div className="demo-window">
            <MainWindow bridge={mainBridge} />
          </div>
        )}
        {view === 'tablet' && (
          <div className="demo-tablet">
            <RemoteScreen bridge={tabletBridge} deviceName="Studio iPad" confirmStop={() => true} />
          </div>
        )}
        {view === 'companion' && <Companion app={app} />}
      </div>
    </div>
  )
}

/** A stand-in for the team's companion app, sending data over the same API. */
function Companion({ app }: { app: DemoApp }) {
  const bridge = useMemo(() => app.bridge('data'), [app])
  const [s, setS] = useState(app.controller.state.data)
  const [guest, setGuest] = useState('')
  useEffect(() => bridge.onState((st) => setS(st.data)), [bridge])
  const score = (k: string) => Number(s[k]?.value ?? 0)
  const send = (values: Record<string, string | number>) => bridge.command('data.set', { values })
  return (
    <div className="companion">
      <h2>Pretend companion app</h2>
      <p className="muted">
        This is what the team's companion app does from another PC: it sends values, and they appear on stream at once. Switch to
        the Main window to see the scoreboard and lower third change. It can only send data; it can't switch scenes.
      </p>
      <div className="companion-grid">
        <div className="panel">
          <h3>Scoreboard</h3>
          <div className="score-row">
            <span>{String(s['team1.name']?.value ?? 'Team 1')}</span>
            <strong>{score('team1.score')}</strong>
            <button onClick={() => send({ 'team1.score': score('team1.score') + 1 })}>+1</button>
          </div>
          <div className="score-row">
            <span>{String(s['team2.name']?.value ?? 'Team 2')}</span>
            <strong>{score('team2.score')}</strong>
            <button onClick={() => send({ 'team2.score': score('team2.score') + 1 })}>+1</button>
          </div>
          <button className="ghost" onClick={() => send({ 'team1.score': 0, 'team2.score': 0 })}>
            Reset scores
          </button>
        </div>
        <div className="panel">
          <h3>Lower third</h3>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              send({ 'guest.name': guest })
              setGuest('')
            }}
          >
            <input placeholder="Guest name" value={guest} onChange={(e) => setGuest(e.target.value)} />
            <button className="accent">Send</button>
          </form>
          <p className="muted small">Now showing: {String(s['guest.name']?.value ?? '') || 'nothing'}</p>
        </div>
        <div className="panel">
          <h3>What it sends</h3>
          <pre className="code-sample">{`{ "type": "data",
  "set": { "team1.score": ${score('team1.score')} } }`}</pre>
          <p className="muted small">JSON over a WebSocket on the local network. See docs/PROTOCOL.md.</p>
        </div>
      </div>
    </div>
  )
}

// No StrictMode: it would start the simulated app twice.
createRoot(document.getElementById('root')!).render(<Demo />)
