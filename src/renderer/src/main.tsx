/**
 * The main window, opened in Chrome or Edge on the streaming PC at
 * http://localhost:7420. It controls the app and, as the first main window
 * open, also runs the studio: the live video and sound that go out.
 */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WsBridge, type Status } from './bridge/wsBridge'
import { MainWindow } from './MainWindow'
import { Studio } from './studio/studio'
import './styles.css'

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
const bridge = new WsBridge(`${proto}//${location.host}/ws`, { local: true })

function App() {
  const [status, setStatus] = useState<{ s: Status; detail?: string }>({ s: 'connecting' })
  const [studio, setStudio] = useState<Studio | null>(null)
  const studioRef = useRef<Studio | null>(null)
  const [elsewhere, setElsewhere] = useState(false)

  useEffect(() => {
    const off = bridge.onStatus((s, detail) => {
      setStatus({ s, detail })
      if (s !== 'connected') return
      setElsewhere(!bridge.studio)
      if (bridge.studio && !studioRef.current) {
        const st = new Studio(bridge)
        studioRef.current = st
        setStudio(st)
        void st.start()
      } else if (!bridge.studio && studioRef.current) {
        studioRef.current.stop()
        studioRef.current = null
        setStudio(null)
      }
    })
    bridge.connect()
    return () => {
      off()
    }
  }, [])

  // The studio follows every state change: scenes, sources, mixer, stream and record.
  useEffect(() => {
    if (!studio) return
    void bridge.getState().then((s) => studio.update(s))
    const off = bridge.onState((s) => studio.update(s))
    return () => {
      off()
    }
  }, [studio])

  // Closing this tab stops the video: ask first while live or recording.
  useEffect(() => {
    if (!studio) return
    const live = { current: false }
    const warn = (e: BeforeUnloadEvent) => {
      if (live.current) e.preventDefault()
    }
    const off = bridge.onState((s) => (live.current = s.stream.live || s.recording.active))
    window.addEventListener('beforeunload', warn)
    return () => {
      off()
      window.removeEventListener('beforeunload', warn)
    }
  }, [studio])

  return (
    <>
      {status.s === 'offline' && (
        <div className="offline-bar" role="alert">
          {status.detail ?? 'Lost the connection to the app. Is it still running? Trying again…'}
        </div>
      )}
      <MainWindow bridge={bridge} studio={studio} studioElsewhere={elsewhere} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
