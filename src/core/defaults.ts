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
          { id: 'live-atem', name: 'ATEM program feed', kind: 'atem', visible: true }
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
      { id: 'atem-audio', name: 'ATEM', volume: 0.8, muted: false, level: 0 },
      { id: 'mic', name: 'Mic', volume: 0.8, muted: false, level: 0 },
      { id: 'desktop', name: 'Desktop', volume: 0.6, muted: false, level: 0 },
      { id: 'music', name: 'Music', volume: 0.4, muted: true, level: 0 }
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
    atem: {
      connected: false,
      host: '',
      model: '',
      inputs: [],
      program: null,
      preview: null,
      inTransition: false
    },
    data: {},
    devices: { pairingOpen: true, pairingCode: '', controlUrl: '', list: [] },
    stats: { ...IDLE_STATS }
  }
}
