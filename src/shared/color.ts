/**
 * Colour controls for the picture that goes out (Live, and Preview so the
 * next scene looks the same before it goes on air): exposure, white balance
 * (warmer/cooler and tint), contrast and saturation.
 *
 * Every control is "0 = as it comes in", so Reset is all zeros. The Overlay
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
}

export const NEUTRAL_GRADE: ColorGrade = { exposure: 0, temperature: 0, tint: 0, contrast: 0, saturation: 0 }

export const GRADE_LIMITS: Record<keyof ColorGrade, [number, number]> = {
  exposure: [-2, 2],
  temperature: [-100, 100],
  tint: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100]
}

export const GRADE_KEYS = Object.keys(GRADE_LIMITS) as (keyof ColorGrade)[]

/** True when the picture is left as it comes in. */
export function isNeutral(g: ColorGrade | undefined | null): boolean {
  return !g || GRADE_KEYS.every((k) => !g[k])
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
  return c.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]
}
