import type { AppState, FpsFamily, Platform, Quality } from './state'

export interface QualityPreset {
  label: string
  width: number
  height: number
  fps: number
  videoKbps: number
  audioKbps: number
  /** Short description shown under the Low/Medium/High buttons. */
  summary: string
}

/**
 * Quality presets replace OBS's encoder, rate control and resolution settings.
 * Bitrates follow common platform guidance and stay under Twitch's 6000 kbps cap.
 */
export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: { label: 'Standard', width: 1280, height: 720, fps: 30, videoKbps: 2500, audioKbps: 160, summary: '720p, 30 fps (like OBS)' },
  medium: { label: 'Medium', width: 1920, height: 1080, fps: 30, videoKbps: 4500, audioKbps: 160, summary: '1080p, 30 fps' },
  high: { label: 'High', width: 1920, height: 1080, fps: 60, videoKbps: 6000, audioKbps: 160, summary: '1080p, 60 fps' }
}

export interface PlatformInfo {
  label: string
  /** Fixed ingest address. Empty when the platform hands out a new address per stream. */
  ingestUrl: string
  needsServerUrl: boolean
  vertical: boolean
  help: string
}

export const PLATFORMS: Record<Platform, PlatformInfo> = {
  youtube: {
    label: 'YouTube',
    ingestUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
    needsServerUrl: false,
    vertical: false,
    help: 'YouTube Studio, Create, Go live, Stream: copy the stream key.'
  },
  facebook: {
    label: 'Facebook',
    ingestUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    needsServerUrl: false,
    vertical: false,
    help: 'Facebook Live Producer, Streaming software: copy the stream key.'
  },
  instagram: {
    label: 'Instagram',
    ingestUrl: '',
    needsServerUrl: true,
    vertical: true,
    help: 'Instagram on desktop, Create, Live: copy the stream URL and key. Instagram gives a new key every time.'
  },
  twitch: {
    label: 'Twitch',
    ingestUrl: 'rtmp://live.twitch.tv/app',
    needsServerUrl: false,
    vertical: false,
    help: 'Twitch Creator Dashboard, Settings, Stream: copy the primary stream key.'
  },
  kick: {
    label: 'Kick',
    ingestUrl: '',
    needsServerUrl: true,
    vertical: false,
    help: 'Kick dashboard, Settings, Stream URL and Key.'
  },
  custom: {
    label: 'Custom',
    ingestUrl: '',
    needsServerUrl: true,
    vertical: false,
    help: 'Any RTMP or RTMPS server address and key.'
  }
}

/** At most this many platforms at once (optional multistream). */
export const MAX_DESTINATIONS = 3

/**
 * The quality with the frame rate in use: 25 instead of 30 (and 50 instead of 60)
 * when the cameras send 25 or 50, so no picture is shown twice (that looks like dropped frames).
 */
export function presetFor(quality: Quality, family: FpsFamily = 'ntsc'): QualityPreset {
  const p = QUALITY_PRESETS[quality]
  if (family !== 'pal') return p
  const fps = p.fps >= 50 ? 50 : 25
  return { ...p, fps, summary: p.summary.replace(/\d+ fps/, `${fps} fps`).replace(' (like OBS)', '') }
}

/** 25, 50, 30, 60 (or 24, 29.97...) frames a second: which family it belongs to, or null if neither. */
export function familyOf(fps: number): FpsFamily | null {
  if (!(fps > 0)) return null
  if (Math.abs(fps - 25) < 0.6 || Math.abs(fps - 50) < 1.2) return 'pal'
  if (Math.abs(fps - 30) < 0.6 || Math.abs(fps - 60) < 1.2) return 'ntsc'
  return null
}

const fpsText = (f: number) => `${Math.round(f * 100) / 100} fps`

/**
 * Which frame rate family the cameras in the scenes send.
 *
 * - Network cameras (Z CAM, RTMP cameras) send at their own fixed rate, measured on arrival.
 * - A camera on this PC that can't go above 25 or 50 is set to that rate (an ATEM on 1080p25).
 * - Other cameras on this PC (webcams) can run at either, so they don't decide.
 *
 * Cameras that disagree: family null, and the note names them so the person can pick.
 */
export function cameraRate(
  state: Pick<AppState, 'scenes' | 'inputs'>,
  netFps: (deviceId: string) => number,
  deviceRate: (deviceId: string) => { fps: number; max: number } | null
): { family: FpsFamily | null; note: string } {
  const ids = new Set<string>()
  for (const s of state.scenes) for (const l of s.layers) if (l.kind === 'video' && l.device) ids.add(l.device)
  const fixed: { name: string; fps: number; family: FpsFamily }[] = []
  let flexible = false
  for (const id of ids) {
    const name = (state.inputs.video.find((d) => d.id === id)?.name ?? id).replace(/ \(network\)$/, '')
    if (id.startsWith('net:')) {
      const fps = netFps(id)
      const family = familyOf(fps)
      if (family) fixed.push({ name, fps, family })
      continue
    }
    const r = deviceRate(id)
    if (!r) continue
    if (familyOf(r.max) === 'pal') fixed.push({ name, fps: r.max, family: 'pal' })
    else if (familyOf(r.fps)) flexible = true
  }
  const list = fixed.map((c) => `${c.name} ${fpsText(c.fps)}`).join(', ')
  const families = new Set(fixed.map((c) => c.family))
  if (families.size > 1) return { family: null, note: `Cameras differ: ${list}` }
  if (families.size === 1) return { family: fixed[0].family, note: list }
  return { family: flexible ? 'ntsc' : null, note: '' }
}

export function requiredUploadKbps(quality: Quality, enabledCount: number): number {
  const p = QUALITY_PRESETS[quality]
  return enabledCount * (p.videoKbps + p.audioKbps)
}
