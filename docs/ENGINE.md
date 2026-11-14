# Video engine and inputs (web version)

## How the video and audio get in

Like OBS, this app does not switch cameras. Cameras plug into the ATEM and are switched there. The app takes in what the ATEM or HyperDeck sends, as sources you can put in scenes.

The main window, open in Chrome or Edge on the streaming PC, opens the devices with the browser's camera and microphone access (`getUserMedia`). The browser gives each device its real name.

| Device | How it connects | Video | Audio |
| --- | --- | --- | --- |
| ATEM Mini, Mini Pro, Mini Extreme | USB-C to the PC | A camera named "Blackmagic Design" | A USB audio input from the same box; "Sound from a video input" finds it by the box it belongs to |
| HyperDeck, or a larger ATEM | HDMI or SDI into a DeckLink card or UltraStudio box, or an HDMI capture stick | A camera (DeckLink needs Blackmagic Desktop Video's webcam driver) | The capture device's audio input |
| USB audio interface: Zoom LiveTrak L-12, Focusrite Scarlett | USB, with the maker's driver installed | none | Each input or pair on its own fader, as far as Windows audio exposes them |

- **Names.** Windows names like "Microphone (2- ZOOM L-12 Audio)" are shown device first: "ZOOM L-12 Audio · Microphone". USB ids that Chrome adds, like "(1edb:be55)", are removed.
- **Channels.** The app asks each audio device for up to 32 channels and uses what it gets. Many drivers give the browser only a stereo pair; Focusrite lists each pair as its own device ("Analogue 1 + 2", "3 + 4"). ASIO (every L-12 input separately) is not available in a browser; that comes with the desktop version.
- **Sync offset.** The ATEM's picture usually reaches the PC a few frames after the sound from a separate interface. Each audio channel can be held back 0 to 5000 ms. Clap on camera and adjust until it lines up.
- **Plugging in and out.** The list updates by itself. A channel or source whose device is unplugged says so, and comes back by itself when the device is plugged in again. If the browser gives a device a new id (after clearing site data), the app finds it again by name.
- **Voice processing is off**: no echo cancelling, noise suppression or automatic gain, so music and room mics sound as they are.

## Drawing the scenes

The main window draws Live (full quality, the size of the quality preset) and Preview (smaller) on canvases, at the preset's frame rate, from a timer that keeps running when the window is in the background. Sources are drawn back to front, each in its place (fill, centre, lower third, top, corners). Fades mix the old and new scene.

## Sound

Each fader is: device input → its channels → delay (sync offset) → volume → meter → program mix (Web Audio, 48 kHz). One device is opened once and shared, so an L-12 can feed one fader per mic.

## Streaming and recording

While streaming or recording, the main window encodes the Live picture and the program sound once (`MediaRecorder`, H.264 when the browser can, at twice the platform bitrate) and sends it to the app server over a local WebSocket. The server hands it to ffmpeg:

- **Stream:** re-encoded to H.264 + AAC with a keyframe every 2 seconds, sent to every platform at once (ffmpeg's `tee`, so one encode). Instagram gets a vertical 720×1280 picture cut from the middle. If one platform fails, the others keep going.
- **Recording:** MKV keeps the browser's picture as it is; MP4 keeps it when it is H.264, otherwise re-encodes. MP4 recordings are fragmented, so they stay playable if the PC crashes.
- **Encoder:** the first that works of NVIDIA NVENC, Intel QuickSync, AMD AMF, then x264 on the processor. Checked once when the app starts.
- **ffmpeg** comes with `npm install` (`ffmpeg-static`). Set `FFMPEG_PATH` to use another build.

If the stream drops, the app stops it, says why in plain words, and the tablet sees the same notice.

## Later: the desktop app (.exe)

The web version is built so it can be wrapped without a rewrite:

- An Electron (or Tauri) shell starts the same app server (`src/server/index.ts`) and opens the same main window at `http://localhost:7420`. No screen code changes.
- In the desktop shell, the parts the browser can't do get added next to what exists: browser sources (a hidden web view per overlay), ASIO audio for every L-12 input, no click needed for screen and desktop capture, and stream keys in Windows' encrypted storage.
- The tablet remote, companion app and stream deck don't change at all: they use the same control API.
