/**
 * What a graphics page (from a gfx app on the network) gets in the desktop
 * version: a way to send its sound to the mixer, and to pass a commercial the
 * gfx operator cued (window.streamerCue). Nothing else.
 *
 *   const answer = await window.streamerAudio.connect(offer.sdp)
 *
 * The page makes a WebRTC offer with one audio track (its video's sound); the
 * main window answers and puts that sound on the mixer, under the source.
 */
const { contextBridge, ipcRenderer } = require('electron')

// Cue to stream: pass a commercial the gfx operator cued ({ take, name, url } or { take, clear: true }).
// A break of several: { take, items: [{ name, url }] }.
contextBridge.exposeInMainWorld('streamerCue', (c) =>
  ipcRenderer.invoke(
    'gfx:cue',
    c && typeof c === 'object'
      ? {
          take: c.take,
          name: c.name,
          url: c.url,
          items: Array.isArray(c.items) ? c.items.slice(0, 20).map((x) => ({ name: String(x?.name ?? ''), url: String(x?.url ?? '') })) : undefined,
          clear: c.clear === true,
          onAir: c.onAir === true
        }
      : null
  )
)

// Hand a video over to the streaming app, which plays it itself (smooth, on the graphics card):
// { take, url, shows: 'full' | 'box', loop, sound } or { take, stop: true }.
// When it ends, the page gets a 'streamer:video-ended' event with detail { take }.
contextBridge.exposeInMainWorld('streamerVideo', (v) =>
  ipcRenderer.invoke(
    'gfx:video',
    v && typeof v === 'object'
      ? { take: String(v.take ?? ''), url: typeof v.url === 'string' ? v.url : '', shows: v.shows === 'box' ? 'box' : 'full', loop: v.loop === true, sound: v.sound !== false, stop: v.stop === true }
      : null
  )
)
ipcRenderer.on('gfx:video-ended', (_e, take) => window.dispatchEvent(new CustomEvent('streamer:video-ended', { detail: { take: String(take) } })))

contextBridge.exposeInMainWorld('streamerAudio', {
  connect: (sdp) => {
    if (typeof sdp !== 'string' || sdp.length > 100_000) return Promise.reject(new Error('Not an offer'))
    return ipcRenderer.invoke('gfx:audio-offer', sdp)
  }
})
