import type { Platform, Quality } from './state'

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
  low: { label: 'Low', width: 1280, height: 720, fps: 30, videoKbps: 3000, audioKbps: 128, summary: '720p, 30 fps' },
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

export function requiredUploadKbps(quality: Quality, enabledCount: number): number {
  const p = QUALITY_PRESETS[quality]
  return enabledCount * (p.videoKbps + p.audioKbps)
}
