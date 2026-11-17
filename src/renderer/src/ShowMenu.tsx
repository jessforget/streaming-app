/**
 * The show menu, top left of the main window: the show's name, whether it is
 * saved, and Save / Save as / Open / New, so each show can keep its own
 * standard layout. Settings and About are at the right of the top bar.
 */
import { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/state'
import type { Bridge } from './bridge/bridge'
import type { Run } from './useApp'

export type ShowDialogKind = 'open' | 'saveAs' | 'new'

interface ShowRow {
  file: string
  name: string
  savedAt: number
  scenes: number
}

function savedWhen(at: number): string {
  if (!at) return ''
  const d = new Date(at)
  const today = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `today ${time}`
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${time}`
}

/** Save the show now: to its own file, or ask for a name the first time. */
export function saveShow(state: AppState, run: Run, ask: (k: ShowDialogKind) => void) {
  if (state.show.file) void run('show.save', {})
  else ask('saveAs')
}

export function ShowMenu(props: { state: AppState; run: Run; bridge: Bridge; open: (k: ShowDialogKind) => void; openAbout: () => void; notice: (m: string) => void }) {
  const { state, run, bridge, open, openAbout, notice } = props
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = state.stream.live || state.recording.active
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setMenu(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])

  const pick = (fn: () => void) => () => {
    setMenu(false)
    fn()
  }
  const download = async () => {
    const r = await bridge.command('show.export', {})
    if (!r.ok) return notice(r.error ?? 'Could not make the show file')
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${state.setupName.replace(/[<>:"/\\|?*]/g, ' ').trim() || 'Show'}.show.json`
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }
  const importFile = async (f: File | undefined) => {
    if (!f) return
    let show: unknown
    try {
      show = JSON.parse(await f.text())
    } catch {
      return notice('That file isn’t a show file (it can’t be read).')
    }
    const ok = await run('show.import', { show })
    if (ok) notice(`Opened ${f.name}. It is kept with your other shows now.`)
  }

  const status = state.show.changed ? 'Changes not saved' : state.show.file ? `Saved ${savedWhen(state.show.savedAt ?? 0)}`.trim() : 'Not saved yet'
  return (
    <div className="show-menu" ref={box}>
      <button className={`show-button ${menu ? 'open' : ''}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} title="Save, open or start a show">
        <span className="show-label">
          <strong>{state.setupName}</strong>
          <span className={`show-status ${state.show.changed ? 'unsaved' : ''}`}>
            {state.show.changed && <span className="dot" aria-hidden="true" />}
            {status}
          </span>
        </span>
        <span className="chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {state.engine.mode === 'simulated' && (
        <span className="pill practice" title={state.engine.note}>
          Practice mode
        </span>
      )}
      {menu && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={pick(() => saveShow(state, run, open))}>
            Save show<kbd>Ctrl+S</kbd>
          </button>
          <button role="menuitem" onClick={pick(() => open('saveAs'))}>
            Save as a new show…
          </button>
          <button role="menuitem" onClick={pick(() => open('open'))} disabled={busy} title={busy ? 'Stop streaming and recording first' : undefined}>
            Open show…<kbd>Ctrl+O</kbd>
          </button>
          <button role="menuitem" onClick={pick(() => open('new'))} disabled={busy} title={busy ? 'Stop streaming and recording first' : undefined}>
            New show…
          </button>
          <hr />
          <button role="menuitem" onClick={pick(() => void download())}>
            Download show file
            <small>To take it to another PC</small>
          </button>
          <button role="menuitem" onClick={pick(() => fileInput.current?.click())} disabled={busy}>
            Open a show file…
            <small>From another PC or a USB stick</small>
          </button>
          <hr />
          <button role="menuitem" onClick={pick(openAbout)}>
            About
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          void importFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** Open, Save as, and New: one window each. */
export function ShowDialog(props: { kind: ShowDialogKind; state: AppState; run: Run; bridge: Bridge; onKind: (k: ShowDialogKind) => void; onClose: () => void }) {
  const { kind, state, run, bridge, onKind, onClose } = props
  const [rows, setRows] = useState<ShowRow[] | null>(null)
  const [folder, setFolder] = useState('')
  const [error, setError] = useState('')
  const [name, setName] = useState(kind === 'new' ? '' : kind === 'saveAs' && !state.show.file ? state.setupName : '')
  const [selected, setSelected] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'delete' | 'unsaved' | null>(null)
  const [working, setWorking] = useState(false)

  const load = async () => {
    const r = await bridge.command('show.list', {})
    if (!r.ok) return setError(r.error ?? 'Could not list the shows')
    const d = r.data as { folder: string; shows: ShowRow[] }
    setRows(d.shows)
    setFolder(d.folder)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  useEffect(() => setConfirm(null), [selected])

  const go = async (fn: () => Promise<boolean>) => {
    setWorking(true)
    const ok = await fn()
    setWorking(false)
    if (ok) onClose()
  }
  const taken = rows?.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase() && name.trim())

  const openSelected = (skipCheck = false) => {
    if (!selected) return
    if (state.show.changed && !skipCheck) return setConfirm('unsaved')
    void go(() => run('show.open', { file: selected }))
  }

  const title = kind === 'open' ? 'Open show' : kind === 'saveAs' ? 'Save as a new show' : 'New show'
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal shows" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body stack">
          {kind === 'new' && (
            <p className="muted small">
              Starts from the standard scenes and sound. Your stream keys, quality and recording folder stay as they are.
              {state.show.changed ? ` Changes to ${state.setupName} that aren’t saved will be lost.` : ''}
            </p>
          )}
          {kind !== 'open' && (
            <label className="field">
              <span>Show name</span>
              <input
                autoFocus
                value={name}
                maxLength={60}
                placeholder={kind === 'new' ? 'Sunday service' : `${state.setupName} (copy)`}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && name.trim() && !working && (kind === 'new' ? void go(() => run('show.new', { name: name.trim() })) : void go(() => run('show.save', { name: name.trim() })))}
              />
            </label>
          )}
          {kind === 'saveAs' && taken && <p className="warn-text small">A show called {taken.name} is already saved. Saving replaces it.</p>}

          {kind === 'open' && (
            <>
              {error && <p className="warn-text">{error}</p>}
              {rows === null && !error && <p className="muted">Looking for saved shows…</p>}
              {rows?.length === 0 && (
                <div className="empty-shows">
                  <strong>No saved shows yet</strong>
                  <p className="muted small">Set up the scenes, sources and sound for a show, then choose Save show in the show menu (or press Ctrl+S).</p>
                  <button onClick={() => onKind('saveAs')}>Save this show now</button>
                </div>
              )}
              {!!rows?.length && (
                <ul className="show-list" role="listbox" aria-label="Saved shows">
                  {rows.map((r) => (
                    <li key={r.file}>
                      <button
                        role="option"
                        aria-selected={selected === r.file}
                        className={selected === r.file ? 'on' : ''}
                        onClick={() => setSelected(r.file)}
                        onDoubleClick={() => {
                          setSelected(r.file)
                          if (!state.show.changed) void go(() => run('show.open', { file: r.file }))
                          else setConfirm('unsaved')
                        }}
                      >
                        <strong>{r.name}</strong>
                        <span className="muted small">
                          {r.scenes} {r.scenes === 1 ? 'scene' : 'scenes'} · saved {savedWhen(r.savedAt)}
                        </span>
                        {r.file === state.show.file && <span className="pill">Open now</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {confirm === 'unsaved' && (
                <div className="confirm-row">
                  <span>{state.setupName} has changes that aren’t saved.</span>
                  <button
                    onClick={() =>
                      void go(async () => {
                        const saved = state.show.file ? await run('show.save', {}) : await run('show.save', { name: state.setupName })
                        return saved && (await run('show.open', { file: selected! }))
                      })
                    }
                    disabled={working}
                  >
                    Save, then open
                  </button>
                  <button className="danger" onClick={() => openSelected(true)} disabled={working}>
                    Open without saving
                  </button>
                </div>
              )}
              {confirm === 'delete' && selected && (
                <div className="confirm-row">
                  <span>Delete {rows?.find((r) => r.file === selected)?.name} for good?</span>
                  <button
                    className="danger"
                    onClick={async () => {
                      if (await run('show.delete', { file: selected })) {
                        setSelected(null)
                        await load()
                      }
                    }}
                  >
                    Delete
                  </button>
                  <button className="ghost" onClick={() => setConfirm(null)}>
                    Keep it
                  </button>
                </div>
              )}
            </>
          )}
          {folder && <p className="muted small">Shows are saved in {folder}.</p>}
        </div>
        <footer className="modal-foot">
          {kind === 'open' ? (
            <button className="ghost" disabled={!selected || working} onClick={() => setConfirm('delete')}>
              Delete…
            </button>
          ) : (
            <span />
          )}
          <div className="row-gap">
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            {kind === 'open' && (
              <button className="primary" disabled={!selected || working} onClick={() => openSelected()}>
                Open
              </button>
            )}
            {kind === 'saveAs' && (
              <button className="primary" disabled={!name.trim() || working} onClick={() => void go(() => run('show.save', { name: name.trim() }))}>
                Save
              </button>
            )}
            {kind === 'new' && (
              <button className="primary" disabled={!name.trim() || working} onClick={() => void go(() => run('show.new', { name: name.trim() }))}>
                Start new show
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

/** Ctrl+S saves, Ctrl+O opens: like any other program. */
export function useShowKeys(state: AppState | null, run: Run, open: (k: ShowDialogKind) => void) {
  const latest = useRef({ state, run, open })
  latest.current = { state, run, open }
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      const { state: s, run: go, open: ask } = latest.current
      if (!s) return
      if (k === 's') {
        e.preventDefault()
        saveShow(s, go, ask)
      } else if (k === 'o') {
        e.preventDefault()
        if (!s.stream.live && !s.recording.active) ask('open')
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [])
}
