import type { AppState } from '../shared/state'

export const IDLE_STATS: AppState['stats'] = {
  health: 'idle',
  message: 'Ready',
  fps: 0,
  cpu: 0,
  droppedFrames: 0,
  totalFrames: 0,
  requiredKbps: 0,
  audioLevels: {}
}

/**
 * A fresh install on a real PC: the same scenes and mixer, but with no device
 * chosen yet, because the PC's own devices have their own ids. The app asks
 * for them in the source and audio settings.
 */
export function freshSetup(): AppState {
  const s = defaultState()
  for (const scene of s.scenes) for (const l of scene.layers) if (l.kind === 'video') delete l.device
  s.audio = s.audio.filter((a) => a.kind === 'desktop' || a.id === 'mic')
  for (const a of s.audio) delete a.device
  return s
}

/** The Setup a new install starts with: a typical ATEM multicamera show. */
export function defaultState(): AppState {
  return {
    setupName: 'My show',
    engine: { mode: 'simulated', note: 'Practice mode: nothing is captured or sent' },
    scenes: [
      {
        id: 'starting',
        name: 'Starting soon',
        layers: [
          { id: 'starting-title', name: 'Title', kind: 'text', visible: true, text: 'Starting soon' },
          { id: 'starting-bg', name: 'Background image', kind: 'image', visible: true }
        ]
      },
      {
        id: 'live',
        name: 'Main show',
        layers: [
          { id: 'live-alerts', name: 'Alerts (browser overlay)', kind: 'browser', visible: true },
          { id: 'live-lower-third', name: 'Lower third', kind: 'text', visible: true, text: '{guest.name}' },
          {
            id: 'live-score',
            name: 'Scoreboard',
            kind: 'text',
            visible: false,
            text: '{team1.name} {team1.score} - {team2.score} {team2.name}'
          },
          { id: 'live-atem', name: 'ATEM Mini', kind: 'video', visible: true, device: 'atem-mini' }
        ]
      },
      {
        id: 'playback',
        name: 'HyperDeck playback',
        layers: [
          { id: 'playback-title', name: 'Replay label', kind: 'text', visible: true, text: 'Replay' },
          { id: 'playback-hyperdeck', name: 'HyperDeck', kind: 'video', visible: true, device: 'decklink-1' }
        ]
      },
      {
        id: 'brb',
        name: 'BRB',
        layers: [
          { id: 'brb-title', name: 'Title', kind: 'text', visible: true, text: 'Be right back' },
          { id: 'brb-bg', name: 'Background image', kind: 'image', visible: true }
        ]
      },
      {
        id: 'ending',
        name: 'Ending',
        layers: [
          { id: 'ending-title', name: 'Title', kind: 'text', visible: true, text: 'Thanks for watching' },
          { id: 'ending-bg', name: 'Background image', kind: 'image', visible: true }
        ]
      }
    ],
    previewSceneId: 'starting',
    programSceneId: 'starting',
    transition: { kind: 'fade', durationMs: 300 },
    audio: [
      { id: 'atem-audio', name: 'ATEM Mini', kind: 'device', device: 'atem-mini-audio', volume: 0.8, muted: false, syncOffsetMs: 0, level: 0 },
      { id: 'hyperdeck-audio', name: 'HyperDeck', kind: 'video', device: 'decklink-1', volume: 0.8, muted: false, syncOffsetMs: 0, level: 0 },
      { id: 'mic', name: 'Mic', kind: 'device', device: 'usb-mic', volume: 0.8, muted: false, syncOffsetMs: 0, level: 0 },
      { id: 'desktop', name: 'Desktop', kind: 'desktop', volume: 0.5, muted: false, syncOffsetMs: 0, level: 0 }
    ],
    stream: {
      live: false,
      startedAt: null,
      quality: 'medium',
      destinations: [
        { id: 'youtube', platform: 'youtube', enabled: true, hasKey: false, vertical: false },
        { id: 'facebook', platform: 'facebook', enabled: false, hasKey: false, vertical: false },
        { id: 'instagram', platform: 'instagram', enabled: false, hasKey: false, vertical: true },
        { id: 'twitch', platform: 'twitch', enabled: false, hasKey: false, vertical: false },
        { id: 'kick', platform: 'kick', enabled: false, hasKey: false, vertical: false },
        { id: 'custom', platform: 'custom', enabled: false, hasKey: false, vertical: false }
      ]
    },
    recording: { active: false, startedAt: null, folder: 'Videos/Streams', format: 'mkv' },
    inputs: { video: [], audio: [] },
    data: {},
    devices: { pairingOpen: true, pairingCode: '', controlUrl: '', list: [] },
    stats: { ...IDLE_STATS }
  }
}
