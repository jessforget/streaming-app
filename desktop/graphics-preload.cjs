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
contextBridge.exposeInMainWorld('streamerCue', (c) => ipcRenderer.invoke('gfx:cue', c && typeof c === 'object' ? { take: c.take, name: c.name, url: c.url, clear: c.clear === true } : null))

contextBridge.exposeInMainWorld('streamerAudio', {
  connect: (sdp) => {
    if (typeof sdp !== 'string' || sdp.length > 100_000) return Promise.reject(new Error('Not an offer'))
    return ipcRenderer.invoke('gfx:audio-offer', sdp)
  }
})
