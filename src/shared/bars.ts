/**
 * Color bars: the classic 75% bars with the strip and PLUGE row under them (as on
 * broadcast line-up tapes), as rectangles in a w×h box. Used to line up monitors,
 * the encoder and the platforms before a show; drawn the same way on the processor
 * and on the graphics card.
 */
export interface BarRect {
  x: number
  y: number
  w: number
  h: number
  /** [r, g, b], 0 to 255. */
  rgb: [number, number, number]
}

const G: [number, number, number] = [191, 191, 191]
const Y: [number, number, number] = [191, 191, 0]
const C: [number, number, number] = [0, 191, 191]
const GR: [number, number, number] = [0, 191, 0]
const M: [number, number, number] = [191, 0, 191]
const R: [number, number, number] = [191, 0, 0]
const B: [number, number, number] = [0, 0, 191]
const K: [number, number, number] = [16, 16, 16]

export function barRects(x: number, y: number, w: number, h: number): BarRect[] {
  const out: BarRect[] = []
  const bar = w / 7
  const top = Math.round(h * 0.67)
  const mid = Math.round(h * 0.08)
  const col = (i: number) => Math.round(x + i * bar)
  // Top: grey, yellow, cyan, green, magenta, red, blue.
  ;[G, Y, C, GR, M, R, B].forEach((rgb, i) => out.push({ x: col(i), y, w: col(i + 1) - col(i), h: top, rgb }))
  // Strip: the same bars backwards, with black between.
  ;[B, K, M, K, C, K, G].forEach((rgb, i) => out.push({ x: col(i), y: y + top, w: col(i + 1) - col(i), h: mid, rgb }))
  // Bottom: -I, white, +Q, black, then PLUGE (below black, black, above black), then black.
  const by = y + top + mid
  const bh = y + h - by
  const parts: [number, [number, number, number]][] = [
    [5 / 4, [0, 33, 76]],
    [5 / 4, [235, 235, 235]],
    [5 / 4, [50, 0, 106]],
    [5 / 4, K],
    [1 / 3, [7, 7, 7]],
    [1 / 3, K],
    [1 / 3, [26, 26, 26]],
    [1, K]
  ]
  let at = 0
  for (const [n, rgb] of parts) {
    const x0 = Math.round(x + at * bar)
    at += n
    const x1 = Math.round(x + at * bar)
    out.push({ x: x0, y: by, w: x1 - x0, h: bh, rgb })
  }
  return out
}

/** The line-up tone: 1 kHz. Its level at 100% volume is -20 dBFS (the usual line-up level). */
export const TONE_HZ = 1000
export const TONE_GAIN = 0.1
