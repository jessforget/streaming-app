/**
 * Colour controls for the picture that goes out (Live, and Preview so the
 * next scene looks the same before it goes on air): exposure, white balance
 * (warmer/cooler and tint), contrast and saturation.
 *
 * Every control is "0 = as it comes in", so Reset is all zeros (and straight curves). The Overlay
 * (lower thirds, logos, gfx app items) is never changed: brand colours stay true.
 */
export interface ColorGrade {
  /** Brighter or darker, in stops: -2 to +2. */
  exposure: number
  /** Cooler (blue, -100) to warmer (orange, +100). */
  temperature: number
  /** Green (-100) to magenta (+100). */
  tint: number
  /** Flatter (-100) to punchier (+100). */
  contrast: number
  /** Black and white (-100) to twice as colourful (+100). */
  saturation: number
  /** Tone curves, applied last. Absent = straight lines. */
  curves?: Curves
}

export type CurveChannel = 'all' | 'r' | 'g' | 'b'
export const CURVE_CHANNELS: CurveChannel[] = ['all', 'r', 'g', 'b']
/** Points [in, out], 0 to 1, left to right; the line always runs from x = 0 to x = 1. */
export type CurvePoints = [number, number][]
/** One curve for all colours ('all') and one each for red, green and blue. A missing one is a straight line. */
export type Curves = Partial<Record<CurveChannel, CurvePoints>>

export const STRAIGHT: CurvePoints = [
  [0, 0],
  [1, 1]
]
const MAX_POINTS = 12

/** True when a curve leaves the picture alone. */
export function isStraight(p: CurvePoints | undefined): boolean {
  return !p || p.every(([x, y]) => Math.abs(x - y) < 0.002)
}

/** A curve from a file or a command: 2 to 12 points inside 0..1, sorted, ends at x = 0 and x = 1. Null if not a curve. */
export function cleanCurve(raw: unknown): CurvePoints | null {
  if (!Array.isArray(raw)) return null
  const pts = raw
    .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)))
    .map(([x, y]) => [Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000, Math.round(Math.min(1, Math.max(0, y)) * 1000) / 1000] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const out: CurvePoints = []
  for (const p of pts) if (!out.length || p[0] - out[out.length - 1][0] >= 0.01) out.push(p)
  if (out.length < 2) return null
  out[0] = [0, out[0][1]]
  out[out.length - 1] = [1, out[out.length - 1][1]]
  return out.slice(0, MAX_POINTS - 1).concat(out.length > MAX_POINTS - 1 ? [out[out.length - 1]] : [])
}

/** The curves worth keeping (straight ones dropped), or undefined. */
export function cleanCurves(raw: unknown): Curves | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Curves = {}
  for (const ch of CURVE_CHANNELS) {
    const c = cleanCurve((raw as Record<string, unknown>)[ch])
    if (c && !isStraight(c)) out[ch] = c
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * A smooth curve through the points that never overshoots (monotone cubic,
 * like Photoshop/Resolve curves feel): y for an x, 0..1.
 */
export function curveAt(p: CurvePoints, x: number): number {
  const n = p.length
  if (n < 2) return x
  if (x <= p[0][0]) return p[0][1]
  if (x >= p[n - 1][0]) return p[n - 1][1]
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0] || 1e-6))
  const m: number[] = [d[0]]
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  m.push(d[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const h = a * a + b * b
    if (h > 9) {
      const t = 3 / Math.sqrt(h)
      m[i] = t * a * d[i]
      m[i + 1] = t * b * d[i]
    }
  }
  let i = 0
  while (i < n - 2 && x > p[i + 1][0]) i++
  const [x0, y0] = p[i]
  const [x1, y1] = p[i + 1]
  const h = x1 - x0
  const t = (x - x0) / h
  const t2 = t * t
  const t3 = t2 * t
  const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[i + 1]
  return Math.min(1, Math.max(0, y))
}

/** The curves as a 256-step lookup table per colour (the 'all' curve after each colour's own), RGBA bytes. */
export function curveTable(c: Curves | undefined): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(256 * 4)
  const all = c?.all && !isStraight(c.all) ? c.all : null
  const chans = [c?.r, c?.g, c?.b].map((p) => (p && !isStraight(p) ? p : null))
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    for (let k = 0; k < 3; k++) {
      let v = chans[k] ? curveAt(chans[k]!, x) : x
      if (all) v = curveAt(all, v)
      out[i * 4 + k] = Math.round(v * 255)
    }
    out[i * 4 + 3] = 255
  }
  return out
}

export const NEUTRAL_GRADE: ColorGrade = { exposure: 0, temperature: 0, tint: 0, contrast: 0, saturation: 0 }

export const GRADE_LIMITS: Record<Exclude<keyof ColorGrade, 'curves'>, [number, number]> = {
  exposure: [-2, 2],
  temperature: [-100, 100],
  tint: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100]
}

/** The slider controls (everything but the curves). */
export type GradeKey = keyof typeof GRADE_LIMITS
export const GRADE_KEYS = Object.keys(GRADE_LIMITS) as GradeKey[]

/** True when the picture is left as it comes in. */
export function isNeutral(g: ColorGrade | undefined | null): boolean {
  return !g || (GRADE_KEYS.every((k) => !g[k]) && !cleanCurves(g.curves))
}

/** A grade from a file or a command: numbers only, inside their limits; anything else is 0. */
export function cleanGrade(raw: unknown): ColorGrade {
  const out = { ...NEUTRAL_GRADE }
  if (!raw || typeof raw !== 'object') return out
  for (const k of GRADE_KEYS) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const [lo, hi] = GRADE_LIMITS[k]
    out[k] = Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100
  }
  const curves = cleanCurves((raw as Record<string, unknown>).curves)
  if (curves) out.curves = curves
  return out
}

/**
 * The numbers the graphics card uses: per-channel gain (exposure × white
 * balance), contrast factor around mid-grey, saturation factor. Every step is
 * a straight-line change of each colour, so it gives the same result whether
 * it is applied to each source before they are layered or to the finished picture.
 */
export function gradeMath(g: ColorGrade): { gain: [number, number, number]; contrast: number; saturation: number } {
  const ev = Math.pow(2, g.exposure)
  const warm = g.temperature / 100
  const tint = g.tint / 100
  return {
    gain: [ev * (1 + 0.25 * warm) * (1 + 0.08 * tint), ev * (1 - 0.18 * tint), ev * (1 - 0.25 * warm) * (1 + 0.08 * tint)],
    contrast: Math.pow(2, g.contrast / 100),
    saturation: 1 + g.saturation / 100
  }
}

/** One colour (0..1) through the grade, as the graphics card does it. For tests and the canvas fallback. */
export function gradePixel(g: ColorGrade, rgb: [number, number, number]): [number, number, number] {
  const m = gradeMath(g)
  let c = rgb.map((v, i) => v * m.gain[i])
  c = c.map((v) => (v - 0.5) * m.contrast + 0.5)
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  c = c.map((v) => y + (v - y) * m.saturation)
  c = c.map((v) => Math.min(1, Math.max(0, v)))
  if (g.curves) {
    const t = curveTable(g.curves)
    // Like the graphics card: linear between the 256 table steps.
    c = c.map((v, k) => {
      const f = v * 255
      const i = Math.min(254, Math.floor(f))
      return (t[i * 4 + k] + (t[(i + 1) * 4 + k] - t[i * 4 + k]) * (f - i)) / 255
    })
  }
  return c as [number, number, number]
}
