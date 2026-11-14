/**
 * "Install app": the page opens in its own window, like a real app, with no
 * address bar. Chrome and Edge offer this on the streaming PC (localhost);
 * iPhones and iPads add it from Share, Add to Home Screen. Where neither
 * works (an Android tablet on the plain-http remote), full screen does the
 * same job for the show.
 */
import { useEffect, useState } from 'react'

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// The browser offers the install once, early: keep it for when the button is pressed.
let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    listeners.forEach((fn) => fn())
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    listeners.forEach((fn) => fn())
  })
}

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: window-controls-overlay)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

const isApple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export function InstallButton({ allowFullscreen = false }: { allowFullscreen?: boolean }) {
  const [, redraw] = useState(0)
  const [tip, setTip] = useState(false)
  const [full, setFull] = useState(!!document.fullscreenElement)
  useEffect(() => {
    const fn = () => redraw((n) => n + 1)
    listeners.add(fn)
    const onFull = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFull)
    return () => {
      listeners.delete(fn)
      document.removeEventListener('fullscreenchange', onFull)
    }
  }, [])
  if (standalone()) return null
  if (deferred) {
    return (
      <button
        className="ghost small install"
        title="Open the app in its own window, with no address bar"
        onClick={async () => {
          const d = deferred
          if (!d) return
          await d.prompt()
          await d.userChoice.catch(() => null)
          deferred = null
          redraw((n) => n + 1)
        }}
      >
        Install app
      </button>
    )
  }
  if (isApple()) {
    return (
      <span className="install-wrap">
        <button className="ghost small install" onClick={() => setTip(!tip)}>
          Install app
        </button>
        {tip && (
          <span className="install-tip" role="status">
            Tap Share <b aria-hidden="true">⎙</b>, then <b>Add to Home Screen</b>. Open it from the new icon: no address bar.
          </span>
        )}
      </span>
    )
  }
  if (allowFullscreen && document.documentElement.requestFullscreen) {
    return (
      <button
        className="ghost small install"
        title="Hide the address bar and system bars"
        onClick={() => (full ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: 'hide' })).catch(() => {})}
      >
        {full ? 'Leave full screen' : 'Full screen'}
      </button>
    )
  }
  return null
}
