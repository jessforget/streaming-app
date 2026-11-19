/**
 * The gfx app's server: it holds the rundown (lower thirds, videos, photos,
 * windows), what is in Preview and what is on air, and serves:
 *
 *   /live          the graphics page. Add its address in the streaming app as a
 *                  "Graphics (network)" source (best in its Overlay). See-through.
 *   /app           the operator's page (the gfx app window shows it; a browser works too).
 *   /events        Server-Sent Events: the state, to every page, at once.
 *   /media/...     the video and photo files in the rundown (only those).
 *   /api/...       changes from the operator's page.
 *
 * The streaming app tells the graphics page when it goes on and off the stream;
 * the page tells this server, so an item set to "start when live" animates in,
 * or starts playing, at that moment.
 *
 * Run it on its own (no window, no window capture):  node gfx-app/server.cjs [--port 8765] [--open]
 * Or as the Windows app (gfx-app/main.cjs), which runs this inside.
 *
 * No packages needed: plain Node.js.
 */
const http = require('node:http')
const { createReadStream, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, unlinkSync } = require('node:fs')
const { join, extname, basename, dirname } = require('node:path')
const os = require('node:os')

const PROJECT_FORMAT = 'gfx-app-project'
/** Name, version, revision date, developer and copyright (shared with the streaming app). */
const ABOUT = (() => {
  try {
    return { ...JSON.parse(readFileSync(join(__dirname, '..', 'about.json'), 'utf8')), name: 'Gfx App' }
  } catch {
    return { name: 'Gfx App', version: '', revisionDate: '', developer: 'Jess Limot', copyright: '' }
  }
})()

const KINDS = ['lowerthird', 'video', 'photos', 'window', 'bars']
const STYLES = ['classic', 'block', 'minimal', 'news']
const FONTS = ['Inter', 'Space Grotesk', 'Montserrat', 'Roboto Slab', 'custom']
const POSITIONS = ['left', 'center', 'right']
const ANIMATIONS = ['slide', 'fade', 'wipe']
const SHOWS = ['full', 'box']
const VIDEO_ENDS = ['loop', 'hide', 'hold']
const PHOTO_ENDS = ['loop', 'hold', 'hide']
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.mkv']
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']
const TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
}

const DEFAULT_LOOK = {
  style: 'classic',
  font: 'Inter',
  /** A font installed on the streaming PC (the page is drawn there), when font is 'custom'. */
  customFont: '',
  position: 'left',
  /** Pixels on a 1920 x 1080 picture. */
  nameSize: 52,
  titleSize: 30,
  /** 0 = as long as the words; 1 to 100 = that share of the picture's width. */
  length: 0,
  accent: '#2563d9',
  box: '#f2f2f2',
  text: '#111111',
  /** Seconds before a lower third hides by itself; 0 = until Hide is pressed. */
  stayFor: 0,
  animation: 'slide'
}

const isVideoFile = (p) => VIDEO_EXT.includes(extname(p).toLowerCase())
const isImageFile = (p) => IMAGE_EXT.includes(extname(p).toLowerCase())

/** Only known values get through; anything else keeps what it was. */
function cleanLook(p, was) {
  const pick = (k, list) => (list.includes(p[k]) ? p[k] : was[k])
  const num = (k, lo, hi) => (Number.isFinite(p[k]) ? Math.min(hi, Math.max(lo, Math.round(p[k]))) : was[k])
  const color = (k) => (typeof p[k] === 'string' && /^#[0-9a-f]{6}$/i.test(p[k]) ? p[k] : was[k])
  return {
    style: pick('style', STYLES),
    font: pick('font', FONTS),
    customFont: typeof p.customFont === 'string' ? p.customFont.replace(/[^\w \-]/g, '').slice(0, 60) : was.customFont,
    position: pick('position', POSITIONS),
    nameSize: num('nameSize', 20, 120),
    titleSize: num('titleSize', 12, 80),
    length: num('length', 0, 100),
    accent: color('accent'),
    box: color('box'),
    text: color('text'),
    stayFor: num('stayFor', 0, 600),
    animation: pick('animation', ANIMATIONS)
  }
}

const text = (v, max, d = '') => (typeof v === 'string' ? v.slice(0, max) : d)
const pickOf = (v, list, d) => (list.includes(v) ? v : d)
const numOf = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** One rundown item from what was sent, over what it was (or a fresh one). Paths are checked by the caller. */
function cleanItem(p, was) {
  const kind = was ? was.kind : pickOf(p.kind, KINDS, null)
  if (!kind) throw new Error('kind must be lowerthird, video, photos, window or bars')
  const base = was ?? { id: '', kind, playOnLive: true }
  const item = { ...base }
  if (p.name !== undefined) item.name = text(p.name, 80)
  if (p.playOnLive !== undefined) item.playOnLive = p.playOnLive === true
  if (kind === 'lowerthird') {
    if (p.title !== undefined) item.title = text(p.title, 120)
    item.name ??= ''
    item.title ??= ''
  }
  if (kind === 'video') {
    if (p.shows !== undefined) item.shows = pickOf(p.shows, SHOWS, item.shows ?? 'full')
    if (p.end !== undefined) item.end = pickOf(p.end, VIDEO_ENDS, item.end ?? 'loop')
    if (p.sound !== undefined) item.sound = p.sound !== false
    item.shows ??= 'full'
    item.end ??= 'loop'
    item.sound ??= true
  }
  if (kind === 'photos') {
    if (p.seconds !== undefined) item.seconds = numOf(p.seconds, 1, 600, item.seconds ?? 5)
    if (p.fade !== undefined) item.fade = p.fade === true
    if (p.end !== undefined) item.end = pickOf(p.end, PHOTO_ENDS, item.end ?? 'loop')
    if (p.shows !== undefined) item.shows = pickOf(p.shows, SHOWS, item.shows ?? 'full')
    item.seconds ??= 5
    item.fade ??= true
    item.end ??= 'loop'
    item.shows ??= 'full'
  }
  if (kind === 'bars') {
    // Color bars, with a 1 kHz line-up tone sent to the stream (on unless turned off).
    if (p.sound !== undefined) item.sound = p.sound !== false
    item.sound ??= true
    item.shows = 'full'
  }
  if (kind === 'window') {
    if (p.sourceId !== undefined) item.sourceId = text(p.sourceId, 200)
    if (p.windowName !== undefined) item.windowName = text(p.windowName, 200)
    if (p.shows !== undefined) item.shows = pickOf(p.shows, SHOWS, item.shows ?? 'full')
    item.shows ??= 'full'
  }
  if (!item.name) item.name = { lowerthird: 'Lower third', video: 'Video', photos: 'Photos', window: 'Window', bars: 'Color bars' }[kind]
  return item
}

/**
 * Start the gfx app's server.
 * @param {{ port?: number, dataDir?: string, pagesDir?: string, log?: (s: string) => void }} opts
 * @returns {Promise<{ port: number, server: http.Server, addresses: () => string[], close: () => void }>}
 */
function startServer(opts = {}) {
  const pagesDir = opts.pagesDir ?? __dirname
  const dataDir = opts.dataDir ?? __dirname
  const SAVED = join(dataDir, 'gfx-show.json')
  const log = opts.log ?? ((s) => console.log(s))

  /** The rundown is grouped by kind, in this order: lower thirds, videos, photos and slideshows, windows, color bars. */
  const GROUPS = ['lowerthird', 'video', 'photos', 'window', 'bars']
  const groupOf = (i) => {
    const n = GROUPS.indexOf(i?.kind)
    return n < 0 ? GROUPS.length : n
  }
  const sortByGroup = (items) => {
    const order = new Map(items.map((x, n) => [x, n]))
    items.sort((a, b) => groupOf(a) - groupOf(b) || order.get(a) - order.get(b))
  }

  /** The show: the rundown, the lower thirds' look, Preview and On air. */
  let show = { items: [], look: { ...DEFAULT_LOOK }, previewId: null, onAir: null }
  let nextId = 1
  /** The rundown from a saved file (the app's own save, or a project): items, look, Preview. */
  function readShow(saved) {
    const out = { items: [], look: { ...DEFAULT_LOOK }, previewId: null, onAir: null }
    let next = 1
    const items = Array.isArray(saved?.items) ? saved.items.slice(0, 2000) : []
    for (const raw of items) {
      try {
        const it = cleanItem(raw, null)
        it.id = typeof raw.id === 'string' && /^item-\d+$/.test(raw.id) && !out.items.some((x) => x.id === raw.id) ? raw.id : ''
        if (it.kind === 'video') it.path = typeof raw.path === 'string' ? raw.path : ''
        if (it.kind === 'photos') it.paths = Array.isArray(raw.paths) ? raw.paths.filter((x) => typeof x === 'string') : []
        out.items.push(it)
      } catch {
        // skip an item we can't read
      }
    }
    for (const it of out.items) {
      const n = Number(/^item-(\d+)$/.exec(it.id)?.[1])
      if (n >= next) next = n + 1
    }
    for (const it of out.items) if (!it.id) it.id = `item-${next++}`
    // Grouped by kind, keeping the order within each group (rundowns saved before groups existed too).
    sortByGroup(out.items)
    out.look = cleanLook(saved?.look ?? {}, DEFAULT_LOOK)
    out.previewId = out.items.some((i) => i.id === saved?.previewId) ? saved.previewId : out.items[0]?.id ?? null
    return { show: out, nextId: next }
  }
  /**
   * The project this rundown belongs to (File menu): its name, its file in the projects folder (or none
   * yet), when it was saved, and what it held then (to tell "changes not saved").
   */
  let project = { name: 'Untitled rundown', file: '', savedAt: 0, saved: '' }
  try {
    const saved = JSON.parse(readFileSync(SAVED, 'utf8'))
    ;({ show, nextId } = readShow(saved))
    if (saved.project && typeof saved.project === 'object') {
      project = {
        name: text(saved.project.name, 80) || 'Untitled rundown',
        file: typeof saved.project.file === 'string' ? basename(saved.project.file) : '',
        savedAt: Number(saved.project.savedAt) || 0,
        saved: typeof saved.project.saved === 'string' ? saved.project.saved : ''
      }
    }
  } catch {
    // First start: a lower third to begin with.
    show.items.push({ id: 'item-1', kind: 'lowerthird', name: 'Sam Rivera', title: 'Guest speaker', playOnLive: true })
    show.previewId = 'item-1'
    nextId = 2
  }

  /** The streaming app's graphics pages that are connected, and whether the stream has them live. */
  const streamPages = new Set()
  let streamLive = false
  /** '' = the stream shows the graphics over every scene; else the scenes they are linked to ("Main show"). */
  let streamOnly = ''
  /** Pages listening for changes, and operator pages (they answer window-capture requests). */
  const listeners = new Set()
  const operators = new Set()
  /** Window-capture requests from graphics pages, waiting for the operator's answer. */
  const pendingRtc = new Map()
  let rtcId = 1
  let hideTimer = null
  let take = 0
  /**
   * A commercial break cued to the stream: one or more videos ({ id, name }), played in order after one
   * Transition. The streaming app copies them, puts its Gfx commercial scene in Preview, and says how it
   * goes: copying, cued, onair (at = which one, pos/dur = its time), done, or failed. Each change to the
   * list is a new take, so the streaming app cues the whole break afresh.
   */
  let cue = null
  let cueTake = 0
  /** Loop the break (also switched in the streaming app); seq counts the switches made here. */
  let breakLoop = false
  let loopSeq = Math.floor(Date.now() / 1000) // never the same as before a restart
  let loopSetAt = 0
  /** The first place in the break that can still change: on air, the ones after the video playing. */
  const firstFree = () => (cue?.status === 'onair' ? (cue.at ?? 0) + 1 : 0)
  /**
   * The break's list changed: a new take, which the streaming app picks up. Before it airs it is cued
   * afresh; on air it stays on air (pending until the streaming app has the new list), and the take
   * it plays (liveTake) still reports how it goes meanwhile.
   */
  function changeBreak(items) {
    if (cue?.status === 'onair') cue = { ...cue, items, take: ++cueTake, pending: true, liveTake: cue.liveTake ?? cue.take }
    else cue = { items, take: ++cueTake, status: streamPages.size ? 'sent' : 'waiting' }
  }
  /** The streaming app's Live picture (JPEG), sent a few times a second, for the On air screen. */
  let program = null
  let programAt = 0
  const programViewers = new Set()
  const hasPicture = () => Date.now() - programAt < 3000
  let pictureShown = false

  const save = () => {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(SAVED, JSON.stringify({ items: show.items, look: show.look, previewId: show.previewId, project }, null, 2))
    } catch (e) {
      log(`Could not save the show: ${e.message}`)
    }
  }

  const item = (id) => show.items.find((i) => i.id === id) ?? null
  /** What every page gets: no file paths, just names (the files come from /media). */
  const publicItem = (i) => {
    if (!i) return null
    const out = { ...i }
    if (i.kind === 'video') {
      out.file = i.path ? basename(i.path) : ''
      out.ok = !!i.path && exists(i.path)
      delete out.path
    }
    if (i.kind === 'photos') {
      out.count = i.paths.length
      out.files = i.paths.map((p) => basename(p))
      delete out.paths
    }
    return out
  }
  const snapshot = () => ({
    type: 'state',
    items: show.items.map(publicItem),
    look: show.look,
    previewId: show.previewId,
    onAir: show.onAir,
    cue,
    breakLoop: { on: breakLoop, seq: loopSeq },
    project: { name: project.name, file: project.file, savedAt: project.savedAt, changed: fingerprint() !== project.saved },
    stream: { connected: streamPages.size > 0, live: streamPages.size > 0 && streamLive, only: streamPages.size > 0 ? streamOnly : '', picture: hasPicture() }
  })
  const send = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`)
  const broadcast = () => {
    const msg = snapshot()
    for (const res of listeners) send(res, msg)
  }
  /** A project with its own file saves itself a moment after each change (the File menu's Save is still there). */
  let autoTimer = null
  const autosave = () => {
    clearTimeout(autoTimer)
    if (!project.file) return
    autoTimer = setTimeout(() => {
      if (!project.file || fingerprint() === project.saved) return
      try {
        writeProject(project.name)
        save()
        broadcast()
      } catch (e) {
        log(`Could not save the project: ${e.message}`)
      }
    }, 1500)
  }
  const changed = () => {
    save()
    autosave()
    broadcast()
  }

  function takeItem(id) {
    const it = item(id)
    if (!it) throw new Error('No such item')
    take++
    show.onAir = { id: it.id, take }
    clearTimeout(hideTimer)
    if (it.kind === 'lowerthird' && show.look.stayFor > 0) {
      hideTimer = setTimeout(() => {
        if (show.onAir?.take !== take) return
        show.onAir = null
        broadcast()
      }, show.look.stayFor * 1000)
    }
  }

  /**
   * Color bars are a line-up picture, not part of the show: once the stream moves away from them (it stops
   * showing the graphics, e.g. a commercial break or a scene that hides the Overlay, or a cued break goes on
   * air) they go off air, so they never come back by themselves afterwards.
   */
  function dropBars() {
    if (show.onAir && item(show.onAir.id)?.kind === 'bars') {
      show.onAir = null
      clearTimeout(hideTimer)
    }
  }

  function addItem(p, local) {
    const it = cleanItem(p, null)
    it.id = `item-${nextId++}`
    if (it.kind === 'video') {
      if (!local) throw new Error('Videos are added on the gfx laptop itself')
      it.path = text(p.path, 1000)
      if (!it.path || !isVideoFile(it.path)) throw new Error('Pick a video file (mp4, webm, mov)')
      if (!p.name) it.name = basename(it.path, extname(it.path))
    }
    if (it.kind === 'photos') {
      if (!local) throw new Error('Photos are added on the gfx laptop itself')
      it.paths = photoPaths(p.paths)
      if (!it.paths.length) throw new Error('Pick some photos (jpg, png, webp)')
      if (!p.name) it.name = it.paths.length === 1 ? basename(it.paths[0], extname(it.paths[0])) : basename(dirname(it.paths[0])) || 'Photos'
    }
    // Into its group: after the selected item when that is one of the same kind, else at the end of the group.
    const sel = show.items.findIndex((i) => i.id === show.previewId)
    const g = groupOf(it)
    let at = sel >= 0 && groupOf(show.items[sel]) === g ? sel + 1 : -1
    if (at < 0) {
      at = show.items.findIndex((i) => groupOf(i) > g)
      if (at < 0) at = show.items.length
    }
    show.items.splice(at, 0, it)
    if (!show.previewId) show.previewId = it.id
    return it
  }

  /** Photo files from a list of files and folders (a folder adds its pictures, sorted by name). */
  function photoPaths(list) {
    const out = []
    for (const p of Array.isArray(list) ? list.slice(0, 2000) : []) {
      if (typeof p !== 'string' || !p) continue
      try {
        if (statSync(p).isDirectory()) {
          for (const f of readdirSync(p).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) if (isImageFile(f)) out.push(join(p, f))
        } else if (isImageFile(p)) out.push(p)
      } catch {
        // not there
      }
    }
    return out.slice(0, 2000)
  }

  // ---------- Projects (File menu): a rundown and its look, saved to a file and opened again ----------
  const PROJECTS = join(dataDir, 'projects')
  /** What a project holds: the items (with their file paths) and the lower thirds' look. */
  const projectData = () => ({ items: show.items.map((i) => ({ ...i })), look: show.look })
  /** What decides "changes not saved": the rundown and the look, not Preview or what's on air. */
  const fingerprint = () => JSON.stringify(projectData())
  const fileFor = (name) => {
    const base = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Rundown'
    return `${base}.gfx.json`
  }
  const projectFile = (name, savedAt) => ({ format: PROJECT_FORMAT, version: 1, name, savedAt, ...projectData() })
  function writeProject(name) {
    const savedAt = Date.now()
    const file = fileFor(name)
    mkdirSync(PROJECTS, { recursive: true })
    writeFileSync(join(PROJECTS, file), JSON.stringify(projectFile(name, savedAt), null, 2))
    project = { name, file, savedAt, saved: fingerprint() }
    return file
  }
  function listProjects() {
    let names = []
    try {
      names = readdirSync(PROJECTS).filter((f) => f.endsWith('.gfx.json'))
    } catch {
      return []
    }
    const out = []
    for (const file of names) {
      try {
        const p = JSON.parse(readFileSync(join(PROJECTS, file), 'utf8'))
        if (p?.format !== PROJECT_FORMAT) continue
        out.push({ file, name: text(p.name, 80) || file.replace(/\.gfx\.json$/, ''), savedAt: Number(p.savedAt) || 0, items: Array.isArray(p.items) ? p.items.length : 0 })
      } catch {
        // not readable: left out
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt)
  }
  /** Nothing may be swapped out from under a break on air, or an item on air. */
  function checkFree() {
    if (cue?.status === 'onair') throw new Error('A commercial break is on air: open or start a rundown when it has ended')
    if (show.onAir) throw new Error('Something is on air: press Hide first')
  }
  /** Put a project's rundown in place (a fresh start: nothing in Preview from before, no break cued). */
  function useProject(p, name, file, savedAt) {
    checkFree()
    const read = readShow(p)
    show = read.show
    nextId = read.nextId
    clearTimeout(hideTimer)
    if (cue && !['onair'].includes(cue.status)) cue = null
    project = { name, file, savedAt, saved: fingerprint() }
  }

  function apply(body, local) {
    switch (body.action) {
      case 'preview': {
        if (!item(body.id)) throw new Error('No such item')
        show.previewId = body.id
        return
      }
      case 'take': {
        takeItem(body.id ?? show.previewId)
        return
      }
      case 'cue': {
        // Add a video to the commercial break (a new break once the last one has played). While the
        // break is on air, it joins the end (or a place after the one playing): the break gets longer.
        const it = item(body.id ?? show.previewId)
        if (!it || it.kind !== 'video') throw new Error('Only videos can be cued as a commercial')
        if (!it.path || !exists(it.path)) throw new Error('That video is not on this laptop any more')
        const open = cue && !['done', 'failed'].includes(cue.status)
        const items = open ? [...cue.items] : []
        if (items.some((x) => x.id === it.id)) throw new Error(`${it.name} is already in the break`)
        if (items.length >= 20) throw new Error('A break holds 20 videos at most')
        const first = firstFree()
        const at = Number.isInteger(body.index) ? Math.min(items.length, Math.max(first, body.index)) : items.length
        items.splice(at, 0, { id: it.id, name: it.name })
        changeBreak(items)
        return cue.items.length
      }
      case 'uncue': {
        // Take one video out of the break (index), or the whole break (not once it is on air).
        const open = cue && !['done', 'failed'].includes(cue.status)
        if (!Number.isInteger(body.index) || !open) {
          if (cue?.status === 'onair') throw new Error('The break is on air now: it ends by itself')
          cue = null
          return
        }
        if (body.index < firstFree()) throw new Error('That one has played or is playing now')
        const items = cue.items.filter((_, i) => i !== body.index)
        if (items.length) changeBreak(items)
        else cue = null
        return
      }
      case 'break-loop': {
        // Play the break again from its first video until this is turned off (then it ends after this round).
        breakLoop = body.on === true
        loopSeq++
        loopSetAt = Date.now()
        return breakLoop
      }
      case 'cue-move': {
        // Play one video of the break earlier or later (on air: only among those still to come).
        if (!cue || ['done', 'failed'].includes(cue.status)) throw new Error('Nothing to move')
        // One step (up or down), or straight to a place (to: dragged in the list).
        const from = Number(body.index)
        const to = Number.isInteger(body.to) ? body.to : from + (body.up ? -1 : 1)
        if (!cue.items[from] || !cue.items[to] || from === to) return
        if (Math.min(from, to) < firstFree()) throw new Error('That one has played or is playing now')
        const items = [...cue.items]
        items.splice(to, 0, ...items.splice(from, 1))
        changeBreak(items)
        return
      }
      case 'hide': {
        // A graphics page asks to hide what ended (a video set to hide at its end): only if that is still what's on.
        if (body.take !== undefined && show.onAir?.take !== body.take) return
        show.onAir = null
        clearTimeout(hideTimer)
        return
      }
      case 'project.list': {
        return { projects: listProjects() }
      }
      case 'project.new': {
        if (!local) throw new Error('Projects are opened and saved on the gfx laptop itself')
        const name = text(body.name, 80) || 'Untitled rundown'
        // A new rundown starts empty, with the look kept (the look is often the same show after show) unless asked.
        useProject({ items: [], look: body.keepLook === false ? {} : show.look }, name, '', 0)
        return
      }
      case 'project.open': {
        if (!local) throw new Error('Projects are opened and saved on the gfx laptop itself')
        const file = basename(String(body.file ?? ''))
        let p
        try {
          p = JSON.parse(readFileSync(join(PROJECTS, file), 'utf8'))
        } catch {
          throw new Error('That project isn’t there any more')
        }
        if (p?.format !== PROJECT_FORMAT) throw new Error('That file isn’t a gfx app project')
        useProject(p, text(p.name, 80) || file.replace(/\.gfx\.json$/, ''), file, Number(p.savedAt) || 0)
        return
      }
      case 'project.save': {
        if (!local) throw new Error('Projects are opened and saved on the gfx laptop itself')
        // Save as: a new name (a new file). Save: its own file (the first time, a name is asked for).
        const name = body.name !== undefined ? text(body.name, 80) : project.file ? project.name : ''
        if (!name) throw new Error('Give the project a name')
        if (body.name !== undefined && body.overwrite !== true && fileFor(name) !== project.file && listProjects().some((x) => x.file === fileFor(name))) {
          throw new Error(`There is already a project called ${name}. Pick another name, or replace it.`)
        }
        return { file: writeProject(name) }
      }
      case 'project.delete': {
        if (!local) throw new Error('Projects are opened and saved on the gfx laptop itself')
        const file = basename(String(body.file ?? ''))
        if (!file.endsWith('.gfx.json')) throw new Error('No such project')
        try {
          unlinkSync(join(PROJECTS, file))
        } catch {
          // already gone
        }
        if (project.file === file) project = { ...project, file: '', saved: '' }
        return
      }
      case 'project.export': {
        return projectFile(project.name, Date.now())
      }
      case 'project.import': {
        if (!local) throw new Error('Projects are opened and saved on the gfx laptop itself')
        const p = body.project
        if (!p || typeof p !== 'object' || p.format !== PROJECT_FORMAT) throw new Error('That file isn’t a gfx app project')
        const name = text(p.name, 80) || 'Imported rundown'
        useProject(p, name, '', 0)
        // Kept with the other projects (a copy, under its own name).
        writeProject(name)
        return { missing: show.items.filter((i) => (i.kind === 'video' && !exists(i.path)) || (i.kind === 'photos' && i.paths.some((x) => !exists(x)))).length }
      }
      case 'next': {
        const i = show.items.findIndex((x) => x.id === show.previewId)
        const step = body.back ? -1 : 1
        const n = show.items[Math.min(show.items.length - 1, Math.max(0, i + step))]
        if (n) show.previewId = n.id
        return
      }
      case 'add': {
        const it = addItem(body.item ?? {}, local)
        show.previewId = it.id
        return it.id
      }
      case 'update': {
        const was = item(body.id)
        if (!was) throw new Error('No such item')
        const next = cleanItem(body.item ?? {}, was)
        if (was.kind === 'photos' && body.item?.paths !== undefined) {
          if (!local) throw new Error('Photos are changed on the gfx laptop itself')
          next.paths = photoPaths(body.item.paths)
        }
        if (was.kind === 'video' && body.item?.path !== undefined) {
          if (!local) throw new Error('Videos are changed on the gfx laptop itself')
          if (!isVideoFile(body.item.path)) throw new Error('Pick a video file (mp4, webm, mov)')
          next.path = text(body.item.path, 1000)
        }
        show.items[show.items.indexOf(was)] = next
        return
      }
      case 'remove': {
        const at = show.items.findIndex((i) => i.id === body.id)
        if (at < 0) return
        show.items.splice(at, 1)
        if (show.onAir?.id === body.id) show.onAir = null
        // A removed video leaves a break that has not played yet.
        if (cue && cue.items.some((x) => x.id === body.id) && !['onair', 'done', 'failed'].includes(cue.status)) {
          const items = cue.items.filter((x) => x.id !== body.id)
          cue = items.length ? { items, take: ++cueTake, status: streamPages.size ? 'sent' : 'waiting' } : null
        }
        if (show.previewId === body.id) show.previewId = show.items[Math.min(at, show.items.length - 1)]?.id ?? null
        return
      }
      case 'move': {
        const at = show.items.findIndex((i) => i.id === body.id)
        const to = at + (body.up ? -1 : 1)
        if (at < 0 || to < 0 || to >= show.items.length) return
        // Items move within their group (lower thirds stay with lower thirds...).
        if (groupOf(show.items[to]) !== groupOf(show.items[at])) return
        show.items.splice(to, 0, ...show.items.splice(at, 1))
        return
      }
      case 'look': {
        show.look = cleanLook(body.look ?? {}, show.look)
        return
      }
      default:
        throw new Error('Unknown action')
    }
  }

  const exists = (p) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }

  /** A file from the rundown, with Range support so videos can seek and stream. */
  function sendFile(req, res, path) {
    let size
    try {
      size = statSync(path).size
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return res.end('That file is not on the gfx laptop any more')
    }
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range && size > 0) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2])
      let end = range[1] && range[2] ? Number(range[2]) : size - 1
      start = Math.max(0, start)
      end = Math.min(size - 1, end)
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` })
        return res.end()
      }
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
      return createReadStream(path, { start, end }).pipe(res)
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    createReadStream(path).pipe(res)
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 2_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'))
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })
  const json = (res, code, value) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const isLocal = (req) => {
    const a = req.socket.remoteAddress ?? ''
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }

  // Adapters made by other programs (WSL, VirtualBox, VMware...): other computers can't reach these, so they go last.
  const VIRTUAL = /vethernet|virtual|vmware|vbox|docker|hyper-v|wsl|loopback|tailscale|zerotier|vpn/i
  const namedAddresses = () =>
    Object.entries(os.networkInterfaces())
      .flatMap(([name, list]) => (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, ip: a.address })))
      .sort((a, b) => Number(VIRTUAL.test(a.name)) - Number(VIRTUAL.test(b.name)))
  const lanAddresses = () => namedAddresses().map((a) => a.ip)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    try {
      if (req.method === 'GET' && (path === '/' || path === '/app' || path === '/control')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(readFileSync(join(pagesDir, 'app.html')))
      }
      if (req.method === 'GET' && path === '/live') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(readFileSync(join(pagesDir, 'live.html')))
      }
      if (req.method === 'GET' && path === '/api/info') {
        // Also how the streaming app's "Find gfx apps" and "Test" know this is a gfx app, and which PC.
        return json(res, 200, {
          app: 'gfx-app',
          name: os.hostname(),
          items: show.items.length,
          port: server.address().port,
          addresses: lanAddresses(),
          named: namedAddresses(),
          local: isLocal(req),
          about: ABOUT
        })
      }
      if (req.method === 'GET' && path === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write('retry: 2000\n\n')
        send(res, snapshot())
        listeners.add(res)
        const role = url.searchParams.get('role')
        // The graphics page inside the streaming app says so: the app shows "connected".
        if (role === 'stream') {
          streamPages.add(res)
          if (cue?.status === 'waiting') cue = { ...cue, status: 'sent' }
          broadcast()
        }
        if (role === 'operator') operators.add(res)
        const ping = setInterval(() => res.write(': ping\n\n'), 15000)
        req.on('close', () => {
          clearInterval(ping)
          listeners.delete(res)
          operators.delete(res)
          if (streamPages.delete(res)) {
            if (!streamPages.size) streamLive = false
            broadcast()
          }
        })
        return
      }
      const media = /^\/media\/([\w-]+)(?:\/(\d+))?$/.exec(path)
      if (req.method === 'GET' && media) {
        const it = item(media[1])
        const file = it?.kind === 'video' ? it.path : it?.kind === 'photos' ? it.paths[Number(media[2] ?? 0)] : undefined
        if (!file) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          return res.end('Not in the rundown')
        }
        return sendFile(req, res, file)
      }
      if (req.method === 'POST' && path === '/api/do') {
        const body = await readBody(req)
        const result = apply(body, isLocal(req))
        changed()
        return json(res, 200, { ok: true, result: result ?? null })
      }
      // The graphics page in the streaming app: the stream put it live, or took it off.
      if (req.method === 'POST' && path === '/api/stream') {
        const body = await readBody(req)
        const wasLive = streamLive
        streamLive = body.live === true
        if (wasLive && !streamLive) dropBars()
        streamOnly = typeof body.only === 'string' ? body.only.slice(0, 300) : ''
        broadcast()
        return json(res, 200, { ok: true })
      }
      // Window capture: a graphics page asks for the window's picture (WebRTC); the operator's window answers.
      if (req.method === 'POST' && path === '/api/rtc/offer') {
        const body = await readBody(req)
        if (!operators.size) return json(res, 503, { error: 'The gfx app window is not open, so it can’t send a window' })
        const id = rtcId++
        const timer = setTimeout(() => {
          pendingRtc.delete(id)
          json(res, 504, { error: 'The gfx app did not answer' })
        }, 15000)
        pendingRtc.set(id, (answer) => {
          clearTimeout(timer)
          json(res, 200, answer)
        })
        const msg = { type: 'rtc-offer', id, itemId: text(body.itemId, 40), sdp: text(body.sdp, 200000) }
        for (const op of operators) send(op, msg)
        return
      }
      // The streaming app says how the cued commercial goes.
      if (req.method === 'POST' && path === '/api/cue') {
        const body = await readBody(req)
        const STATUSES = ['copying', 'cued', 'onair', 'done', 'failed', 'cleared']
        // Loop switched in the streaming app (not just an older report, right after it was switched here).
        if (typeof body.loop === 'boolean' && body.loop !== breakLoop && Date.now() - loopSetAt > 2000) {
          breakLoop = body.loop
          broadcast()
        }
        // From the take asked for, or (while a longer break is on its way) the take on air now.
        if (cue && (body.take === cue.take || body.take === cue.liveTake) && STATUSES.includes(body.status)) {
          const at = Math.max(0, Math.min(cue.items.length - 1, Math.floor(Number(body.at) || 0)))
          const latest = body.take === cue.take
          // A longer break that could not be taken in: it stays as it plays.
          if (latest && body.status === 'failed' && cue.status === 'onair') {
            cue = { ...cue, pending: false, error: body.error ? text(body.error, 200) : 'could not add it' }
            broadcast()
            return json(res, 200, { ok: true })
          }
          cue = {
            ...cue,
            status: body.status,
            at,
            pos: Number(body.pos) || 0,
            dur: Number(body.dur) || 0,
            left: Number(body.left) || 0,
            // The break's sound on the stream, 0 to 1 (the On air bar's meter).
            level: Math.max(0, Math.min(1, Number(body.level) || 0)),
            error: body.error ? text(body.error, 200) : undefined,
            pending: latest ? false : cue.pending,
            liveTake: body.status === 'onair' ? (latest ? body.take : cue.liveTake ?? body.take) : cue.liveTake
          }
          if (body.status === 'cleared') cue = null
          if (body.status === 'onair') dropBars()
          broadcast()
        }
        return json(res, 200, { ok: true })
      }
      // The streaming app's Live picture, a few times a second.
      if (req.method === 'POST' && path === '/api/program') {
        const chunks = []
        let size = 0
        for await (const c of req) {
          size += c.length
          if (size > 3_000_000) return json(res, 413, { error: 'Too big' })
          chunks.push(c)
        }
        const jpg = Buffer.concat(chunks)
        if (jpg[0] !== 0xff || jpg[1] !== 0xd8) return json(res, 400, { error: 'Send a JPEG' })
        program = jpg
        programAt = Date.now()
        for (const v of programViewers) {
          v.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`)
          v.write(jpg)
          v.write('\r\n')
        }
        if (!pictureShown) {
          pictureShown = true
          broadcast()
        }
        res.writeHead(204)
        return res.end()
      }
      if (req.method === 'GET' && path === '/program.mjpg') {
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'cache-control': 'no-store', connection: 'close' })
        programViewers.add(res)
        if (program) {
          res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${program.length}\r\n\r\n`)
          res.write(program)
          res.write('\r\n')
        }
        req.on('close', () => programViewers.delete(res))
        return
      }
      if (req.method === 'POST' && path === '/api/rtc/answer') {
        const body = await readBody(req)
        const done = pendingRtc.get(body.id)
        pendingRtc.delete(body.id)
        done?.(body.error ? { error: text(body.error, 300) } : { sdp: text(body.sdp, 200000) })
        return json(res, 200, { ok: true })
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`Not found: ${path}\n\nThis is the gfx app. Its pages are /app (the operator's page) and /live (the graphics, for the streaming app).`)
    } catch (e) {
      json(res, 400, { error: e.message })
    }
  })

  // The Live picture stopped coming (the streaming app closed): say so once.
  const pictureCheck = setInterval(() => {
    if (pictureShown && !hasPicture()) {
      pictureShown = false
      broadcast()
    }
  }, 1000)

  return new Promise((resolve, reject) => {
    const first = opts.port ?? 8765 // 0 = any free port (tests)
    let port = first
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && first && port < first + 20) {
        log(`Port ${port} is used by another program, trying ${port + 1}...`)
        port += 1
        return server.listen(port, '0.0.0.0')
      }
      reject(e)
    })
    server.on('listening', () =>
      resolve({
        port: server.address().port,
        server,
        addresses: lanAddresses,
        close: () => {
          // A change still waiting to be saved goes into its project now.
          clearTimeout(autoTimer)
          if (project.file && fingerprint() !== project.saved) {
            try {
              writeProject(project.name)
              save()
            } catch {
              // nothing more to do while closing
            }
          }
          clearInterval(pictureCheck)
          for (const res of programViewers) res.end()
          for (const res of listeners) res.end()
          server.close()
        }
      })
    )
    server.listen(port, '0.0.0.0')
  })
}

module.exports = { startServer, cleanLook, cleanItem, DEFAULT_LOOK }

// Run on its own: node gfx-app/server.cjs [--port 8765] [--open]
if (require.main === module) {
  const arg = process.argv.indexOf('--port')
  const port = Number(arg > 0 ? process.argv[arg + 1] : process.env.PORT) || 8765
  startServer({ port })
    .then(({ port: at, addresses }) => {
      console.log('\nThe gfx app is running. Keep this window open.\n')
      console.log(`  Operator page (this PC):  http://localhost:${at}/app`)
      for (const a of addresses()) console.log(`  Add to the streaming app:  http://${a}:${at}/live`)
      if (at !== port) console.log(`\n  Note: port ${port} was taken, so this runs on port ${at}. Use the addresses above.`)
      console.log('')
      if (process.argv.includes('--open')) {
        const target = `http://localhost:${at}/app`
        const cmd = process.platform === 'win32' ? `start "" "${target}"` : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`
        require('node:child_process').exec(cmd, () => {})
      }
    })
    .catch((e) => {
      console.error(`\nThe gfx app could not start: ${e.message}`)
      process.exit(1)
    })
}
