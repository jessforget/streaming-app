# Streaming App

A simpler live streaming and recording app, like OBS, for multicamera shows. Cameras go into a Blackmagic ATEM switcher, and the ATEM does the camera switching. This app takes in the video and audio from the ATEM Mini (USB-C) or a HyperDeck (through a capture card), plus USB audio interfaces like a Zoom L-12 or Focusrite, adds scenes, graphics, audio and live data on top, then streams to one or more platforms at once and records. A tablet can run the show over the local network, a companion app on another PC can send data (scores, names, timers), and a stream deck can plug in the same way later.

It keeps what works in OBS (scenes made of sources, Preview and Live, an audio mixer) and hides the parts that confuse people (encoder settings, two save systems, filter menus).

> **Status: web app, working end to end.** Run it on the streaming PC and open it in Chrome or Edge. Real cameras, capture cards and audio interfaces show up by their own names, the scenes are drawn live, and streaming (RTMP/RTMPS, up to 3 platforms) and recording (MKV or MP4) go through ffmpeg. A desktop app (an `.exe`) comes later by wrapping this same web app; see [docs/ENGINE.md](docs/ENGINE.md).

## Run it on the streaming PC

You need [Node.js](https://nodejs.org) 22 or newer, and Chrome or Edge.

```bash
npm install          # also downloads ffmpeg
npm start            # builds the screens, then starts the app
```

Then open **http://localhost:7420** in Chrome or Edge on the same PC.

- Allow the camera and microphone when the browser asks: that is how the app sees the ATEM, capture cards and audio interfaces, with their real names.
- Click once anywhere on the page so the browser lets the sound start.
- Keep that window open while streaming or recording: it is where the video is made. Minimising it is fine.
- The tablet remote is at `http://<this-pc>:7420/remote` (the address is printed when the app starts and shown in Settings, Remote and devices).
- Settings and stream keys are saved in `%APPDATA%\Streaming App` (Windows) or `~/.streaming-app`.

Try without any hardware: `npm run practice` starts a simulated app (nothing captured or sent) for building the companion app or trying the tablet.

The interactive mockup: after `npm run build`, open `http://localhost:7420/demo` while the app runs.

## What the web version can and can't do

| Works | Limit |
| --- | --- |
| ATEM Mini over USB-C, HDMI capture sticks, DeckLink/UltraStudio (as webcams) | Only devices Windows shows as a camera. DeckLink cards need Blackmagic's "Desktop Video" webcam driver on. |
| USB audio interfaces by name (Zoom L-12, Focusrite), one fader per input or pair | Uses Windows audio (WASAPI). ASIO is not available in a browser; how many inputs show depends on the driver (often 2). |
| Sync offset per audio channel (0 to 5000 ms) | Can only hold sound back, which is the usual fix (video from the ATEM arrives late). |
| Images, video files, text with live data, screen and window capture | Screen, window and desktop sound need a click each time the app starts (the browser asks what to share). |
| Browser sources (web overlays) | Not in the web version: they need the desktop version. |
| Streaming to up to 3 platforms at once; Instagram gets its own vertical 720×1280 picture | Upload speed must cover all of them (the health bar shows how much). |
| Recording to MKV or MP4 | |
| Hardware encoding (NVIDIA, Intel, AMD) picked automatically | Falls back to the processor (x264). |

Stream keys are kept in a file only this Windows user can read, never sent to tablets or other devices.

## Checks

```bash
npm run typecheck
npm test
```

## How it fits together

```
Tablet, companion app, stream deck
        │  local network (WebSocket, port 7420)
        ▼
Streaming PC:  app server (Node) ─► controller ─► ffmpeg ─► YouTube, Facebook, Instagram…
                    ▲  │                              └──► recording file
        WebSocket   │  ▼  state
               main window in Chrome/Edge (the "studio")
               opens cameras and audio, draws Live and Preview,
               mixes the sound, sends the picture to the server
ATEM Mini, capture card, Zoom L-12 ─ USB ─► main window
```

Cameras plug into the ATEM, and camera switching happens on the ATEM itself. The app treats what arrives as video and audio sources, the way OBS does.

- `src/shared`: the protocol, state shape, presets. Used everywhere.
- `src/core`: the controller (every command goes through it), plus the simulated engine used in practice mode.
- `src/server`: the app server: control API, pairing, saving to disk, ffmpeg outputs.
- `src/renderer`: the screens (main window, tablet remote, mockup). `src/renderer/src/studio` is the video and sound work done in the main window.

## Security notes

- The control server listens on the local network. Devices must pair with a 6-digit code shown on the streaming PC; each gets its own key, stored hashed.
- The main window works only from the streaming PC itself (`localhost`); from any other computer you get the tablet remote.
- Don't forward port 7420 on the router.

## License

GPL-2.0-or-later. The bundled ffmpeg build includes GPL parts (x264). See [LICENSE](LICENSE).
