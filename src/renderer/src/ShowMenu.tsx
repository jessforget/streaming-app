/**
 * The File menu, like any program: New, Open, recent projects, Save, Save as,
 * and project files to take to another PC. A project keeps a show's standard
 * layout (scenes, sources, sound, overlays, live data, platforms), so the same
 * setup can be used again for repeat work. Help holds About.
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

/** Save the project now: to its own file, or ask for a name the first time. */
export function saveShow(state: AppState, run: Run, ask: (k: ShowDialogKind) => void) {
  if (state.show.file) void run('show.save', {})
  else ask('saveAs')
}

/** The project's name in the top bar, and whether it is saved. */
export function ProjectName({ state }: { state: AppState }) {
  const status = state.show.changed ? 'Changes not saved' : state.show.file ? `Saved ${savedWhen(state.show.savedAt ?? 0)}`.trim() : 'Not saved yet'
  return (
    <div className="project-name">
      <strong title={state.show.file ? `Project file: ${state.show.file}` : undefined}>{state.setupName}</strong>
      <span className={`show-status ${state.show.changed ? 'unsaved' : ''}`}>
        {state.show.changed && <span className="dot" aria-hidden="true" />}
        {status}
      </span>
      {state.engine.mode === 'simulated' && (
        <span className="pill practice" title={state.engine.note}>
          Practice mode
        </span>
      )}
    </div>
  )
}

type MenuName = 'file' | 'help'

/** The menu bar along the top of the window: File and Help. */
export function MenuBar(props: { state: AppState; run: Run; bridge: Bridge; open: (k: ShowDialogKind) => void; openAbout: () => void; openSettings: () => void; notice: (m: string) => void }) {
  const { state, run, bridge, open, openAbout, openSettings, notice } = props
  const [menu, setMenu] = useState<MenuName | null>(null)
  const [recent, setRecent] = useState<ShowRow[]>([])
  const bar = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = state.stream.live || state.recording.active
  const busyTitle = busy ? 'Stop streaming and recording first' : undefined

  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => !bar.current?.contains(e.target as Node) && setMenu(null)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null)
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])
  useEffect(() => {
    if (menu !== 'file') return
    void bridge.command('show.list', {}).then((r) => {
      if (r.ok) setRecent((r.data as { shows: ShowRow[] }).shows.filter((s) => s.file !== state.show.file).slice(0, 5))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu])

  const pick = (fn: () => void) => () => {
    setMenu(null)
    fn()
  }
  const openRecent = (file: string) => {
    if (state.show.changed) open('open')
    else void run('show.open', { file })
  }
  const download = async () => {
    const r = await bridge.command('show.export', {})
    if (!r.ok) return notice(r.error ?? 'Could not make the project file')
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${state.setupName.replace(/[<>:"/\\|?*]/g, ' ').trim() || 'Project'}.show.json`
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
      return notice('That file isn’t a project file (it can’t be read).')
    }
    const ok = await run('show.import', { show })
    if (ok) notice(`Opened ${f.name}. It is kept with your other projects now.`)
  }
  const head = (name: MenuName, label: string) => (
    <button
      className={`menubar-item ${menu === name ? 'open' : ''}`}
      aria-haspopup="menu"
      aria-expanded={menu === name}
      onClick={() => setMenu(menu === name ? null : name)}
      onMouseEnter={() => menu && menu !== name && setMenu(name)}
    >
      {label}
    </button>
  )

  return (
    <div className="menubar" ref={bar} role="menubar">
      <div className="menubar-slot">
        {head('file', 'File')}
        {menu === 'file' && (
          <div className="menu" role="menu" aria-label="File">
            <button role="menuitem" onClick={pick(() => open('new'))} disabled={busy} title={busyTitle}>
              New project…
            </button>
            <button role="menuitem" onClick={pick(() => open('open'))} disabled={busy} title={busyTitle}>
              Open project…<kbd>Ctrl+O</kbd>
            </button>
            {recent.length > 0 && (
              <>
                <span className="menu-label">Recent projects</span>
                {recent.map((r) => (
                  <button key={r.file} role="menuitem" className="recent" onClick={pick(() => openRecent(r.file))} disabled={busy} title={busyTitle}>
                    {r.name}
                    <small>saved {savedWhen(r.savedAt)}</small>
                  </button>
                ))}
              </>
            )}
            <hr />
            <button role="menuitem" onClick={pick(() => saveShow(state, run, open))}>
              Save project<kbd>Ctrl+S</kbd>
            </button>
            <button role="menuitem" onClick={pick(() => open('saveAs'))}>
              Save project as…<kbd>Ctrl+Shift+S</kbd>
            </button>
            <hr />
            <button role="menuitem" onClick={pick(() => fileInput.current?.click())} disabled={busy} title={busyTitle}>
              Import project file…
              <small>From another PC or a USB stick</small>
            </button>
            <button role="menuitem" onClick={pick(() => void download())}>
              Export project file…
              <small>To take it to another PC</small>
            </button>
            <hr />
            <button role="menuitem" onClick={pick(openSettings)}>
              Settings…
            </button>
          </div>
        )}
      </div>
      <div className="menubar-slot">
        {head('help', 'Help')}
        {menu === 'help' && (
          <div className="menu" role="menu" aria-label="Help">
            <button role="menuitem" onClick={pick(openAbout)}>
              About Streaming App
            </button>
          </div>
        )}
      </div>
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

  const title = kind === 'open' ? 'Open project' : kind === 'saveAs' ? 'Save project as' : 'New project'
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
              <span>Project name</span>
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
          {kind === 'saveAs' && taken && <p className="warn-text small">A project called {taken.name} is already saved. Saving replaces it.</p>}

          {kind === 'open' && (
            <>
              {error && <p className="warn-text">{error}</p>}
              {rows === null && !error && <p className="muted">Looking for saved projects…</p>}
              {rows?.length === 0 && (
                <div className="empty-shows">
                  <strong>No saved projects yet</strong>
                  <p className="muted small">Set up the scenes, sources and sound for a show, then choose File, Save project (or press Ctrl+S).</p>
                  <button onClick={() => onKind('saveAs')}>Save this project now</button>
                </div>
              )}
              {!!rows?.length && (
                <ul className="show-list" role="listbox" aria-label="Saved projects">
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
          {folder && <p className="muted small">Projects are saved in {folder}.</p>}
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
                Start new project
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

/** Ctrl+S saves, Ctrl+Shift+S saves as, Ctrl+O opens: like any other program. */
export function useShowKeys(state: AppState | null, run: Run, open: (k: ShowDialogKind) => void) {
  const latest = useRef({ state, run, open })
  latest.current = { state, run, open }
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = e.key.toLowerCase()
      const { state: s, run: go, open: ask } = latest.current
      if (!s) return
      if (k === 's' && e.shiftKey) {
        e.preventDefault()
        ask('saveAs')
      } else if (e.shiftKey) {
        return
      } else if (k === 's') {
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
