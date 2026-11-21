/**
 * The gfx app's "Stays on" graphics (logo bug, ticker, scoreboard or goal bar, corner countdown),
 * lower-third templates, countdown items and viewer comments: what can be stored, and how it is
 * cleaned when it comes in from a page. Used by server.cjs. Plain Node.js.
 */

const text = (v, max, d = '') => (typeof v === 'string' ? v.slice(0, max) : d)
const pickOf = (v, list, d) => (list.includes(v) ? v : d)
const numOf = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const colorOf = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d)
const boolOf = (v, d) => (typeof v === 'boolean' ? v : d)
const timeOf = (v, d) => (typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v) ? v : d)

const COUNTDOWN_ENDS = ['live', 'hide', 'hold']

/** Every "Stays on" graphic, switched off, with its settings. */
const LAYER_DEFAULTS = {
  logo: {
    on: false,
    /** The picture's file on the gfx laptop (uploaded into the gfx app's folder). */
    file: '',
    /** 0 = left (top) edge, 100 = right (bottom) edge, inside a margin. */
    x: 100,
    y: 0,
    /** Height in pixels on a 1920 x 1080 picture. */
    size: 110,
    opacity: 90,
    live: false,
    clock: false,
    /** A video logo: play over and over (or once each time it comes on, then stay on its last picture). */
    loop: true
  },
  ticker: {
    on: false,
    label: 'Today',
    lines: ['Welcome to the show'],
    /** 1 (slow) to 10 (fast). */
    speed: 5,
    /** 'bottom' = the very bottom; 'above' = a little higher. */
    place: 'bottom',
    accent: '#2563d9',
    box: '#0b0d12',
    text: '#ffffff'
  },
  score: {
    on: false,
    /** 'game' = a score bug; 'goal' = a goal bar (fundraiser, entries). */
    mode: 'game',
    a: 'Home',
    b: 'Away',
    sa: 0,
    sb: 0,
    ca: '#2563d9',
    cb: '#e0443a',
    period: '1st',
    showClock: true,
    /** The game clock: time counted before clockAt, and whether it runs (from clockAt, server time). */
    clockMs: 0,
    clockRun: false,
    clockAt: 0,
    gtitle: 'Our goal',
    raised: 0,
    goal: 1000,
    /** Put before the numbers, e.g. ₱ or $ (empty for plain counts). */
    unit: '₱',
    accent: '#2563d9'
  },
  corner: {
    on: false,
    label: 'Back in',
    /** Count this many minutes, or (when set, "HH:MM") to that time of day. */
    minutes: 5,
    until: '',
    end: 'hide',
    accent: '#2563d9',
    /** While on: when it reaches 0:00 (server time), or the time left while paused. */
    endsAt: 0,
    pausedLeft: null
  }
}
const LAYERS = Object.keys(LAYER_DEFAULTS)

function cleanLayer(name, p, was) {
  const d = LAYER_DEFAULTS[name]
  was = { ...d, ...(was ?? {}) }
  p = p && typeof p === 'object' ? p : {}
  const out = { ...was }
  out.on = boolOf(p.on, was.on)
  if (name === 'logo') {
    // The file is set by an upload only (not from a page).
    out.x = numOf(p.x, 0, 100, was.x)
    out.y = numOf(p.y, 0, 100, was.y)
    out.size = numOf(p.size, 30, 400, was.size)
    out.opacity = numOf(p.opacity, 10, 100, was.opacity)
    out.live = boolOf(p.live, was.live)
    out.clock = boolOf(p.clock, was.clock)
    out.loop = boolOf(p.loop, was.loop)
  }
  if (name === 'ticker') {
    out.label = text(p.label, 40, was.label)
    if (Array.isArray(p.lines)) out.lines = p.lines.filter((x) => typeof x === 'string').map((x) => x.slice(0, 300)).slice(0, 50)
    out.speed = numOf(p.speed, 1, 10, was.speed)
    out.place = pickOf(p.place, ['bottom', 'above'], was.place)
    out.accent = colorOf(p.accent, was.accent)
    out.box = colorOf(p.box, was.box)
    out.text = colorOf(p.text, was.text)
  }
  if (name === 'score') {
    out.mode = pickOf(p.mode, ['game', 'goal'], was.mode)
    out.a = text(p.a, 30, was.a)
    out.b = text(p.b, 30, was.b)
    out.sa = Math.round(numOf(p.sa, 0, 9999, was.sa))
    out.sb = Math.round(numOf(p.sb, 0, 9999, was.sb))
    out.ca = colorOf(p.ca, was.ca)
    out.cb = colorOf(p.cb, was.cb)
    out.period = text(p.period, 20, was.period)
    out.showClock = boolOf(p.showClock, was.showClock)
    out.gtitle = text(p.gtitle, 60, was.gtitle)
    out.raised = Math.round(numOf(p.raised, 0, 1e12, was.raised))
    out.goal = Math.round(numOf(p.goal, 1, 1e12, was.goal))
    out.unit = text(p.unit, 4, was.unit)
    out.accent = colorOf(p.accent, was.accent)
    // The clock is changed by its own actions; from a saved file it comes back stopped where it was.
    out.clockMs = Math.round(numOf(was.clockMs, 0, 1e9, 0))
    out.clockRun = !!was.clockRun
    out.clockAt = Number(was.clockAt) || 0
  }
  if (name === 'corner') {
    out.label = text(p.label, 40, was.label)
    out.minutes = numOf(p.minutes, 0, 600, was.minutes)
    out.until = p.until === '' ? '' : timeOf(p.until, was.until)
    out.end = pickOf(p.end, COUNTDOWN_ENDS, was.end)
    out.accent = colorOf(p.accent, was.accent)
    out.endsAt = Number(was.endsAt) || 0
    out.pausedLeft = Number.isFinite(was.pausedLeft) ? was.pausedLeft : null
  }
  return out
}

/** All the "Stays on" graphics from a saved file (unknown ones are dropped). */
function readLayers(saved) {
  const out = {}
  for (const n of LAYERS) {
    const raw = saved && typeof saved === 'object' ? saved[n] : null
    const l = cleanLayer(n, raw, null)
    if (n === 'logo' && typeof raw?.file === 'string') l.file = raw.file
    if (n === 'score' && raw) {
      l.clockMs = Math.round(numOf(raw.clockMs, 0, 1e9, 0)) + (raw.clockRun && raw.clockAt ? Math.max(0, Date.now() - raw.clockAt) : 0)
      l.clockRun = false
      l.clockAt = 0
    }
    if (n === 'corner' && raw) {
      l.endsAt = Number(raw.endsAt) || 0
      l.pausedLeft = Number.isFinite(raw.pausedLeft) ? raw.pausedLeft : null
    }
    out[n] = l
  }
  return out
}

/** When a countdown reaches 0:00: in `minutes`, or at the next `until` (HH:MM, this PC's time). */
function countdownEnd(minutes, until, now = Date.now()) {
  if (until) {
    const [h, m] = until.split(':').map(Number)
    const d = new Date(now)
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return now + Math.round((Number(minutes) || 0) * 60_000)
}

/** A saved lower-third template: a name and a look. */
function cleanTemplate(p, cleanLook, defaultLook) {
  return { id: '', name: text(p?.name, 60) || 'Template', look: cleanLook(p?.look ?? {}, defaultLook) }
}

const PLATFORMS = ['youtube', 'facebook', 'other']
/** A viewer comment, as it comes in (from the platforms later, or typed in by hand). */
function cleanComment(p) {
  const who = text(p?.who, 60).trim()
  const said = text(p?.text, 300).trim()
  if (!said) throw new Error('A comment needs some words')
  return { platform: pickOf(p?.platform, PLATFORMS, 'other'), who: who || 'Viewer', text: said }
}
/** Hidden words, from "spam, scam, http": lower case, no empties. */
const wordList = (s) =>
  String(s ?? '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 100)

module.exports = { LAYER_DEFAULTS, LAYERS, COUNTDOWN_ENDS, cleanLayer, readLayers, countdownEnd, cleanTemplate, cleanComment, wordList, timeOf }
