# Streaming App

A simpler live streaming and recording app, like OBS, for multicamera shows. Cameras go into a Blackmagic ATEM switcher, and the ATEM does the camera switching. This app takes in the video and audio from the ATEM Mini (USB-C) or a HyperDeck (through a capture card), adds scenes, graphics, audio and live data on top, then streams to one or more platforms at once and records. A tablet can run the show over the local network, a companion app on another PC can send data (scores, names, timers), and a stream deck can plug in the same way later.

It keeps what works in OBS (scenes made of layers, Preview and Live, an audio mixer) and hides the parts that confuse people (encoder settings, two save systems, filter menus). See the project plan for the reasoning.

> **Status: first version, practice mode.** Every screen and button works, and the tablet remote and the control API work over the network. The video engine (OBS's libobs via obs-studio-node) is written but has not yet run on a Windows PC, so until it is installed the app runs in practice mode: nothing is captured or sent. See [docs/ENGINE.md](docs/ENGINE.md).

## What's here

| Part | Where | State |
| --- | --- | --- |
| Main window, like OBS: scenes, Preview/Live, sources, audio mixer, data fields, settings | `src/renderer` | Works |
| Add, remove, rename and reorder scenes and sources; add audio channels | `src/renderer/src/Editors.tsx`, `src/core/controller.ts` | Works, tested |
| ATEM Mini and HyperDeck as video and audio inputs (no camera switching in the app) | `src/main/engine/obsEngine.ts` | Written, not yet run on Windows |
| Tablet remote, served by the app at `http://<pc>:7420/remote` | `src/renderer/src/Remote.tsx` | Works |
| Control API for tablet, companion app and stream deck | `src/main/control`, [docs/PROTOCOL.md](docs/PROTOCOL.md) | Works, tested |
| Streaming to up to 3 platforms (YouTube, Facebook, Instagram, Twitch, Kick, custom) | `src/core/controller.ts` | Logic works and tested; real output needs the engine |
| Video engine (capture, encode, RTMP, record) | `src/main/engine/obsEngine.ts` | Written, not yet run on Windows |
| Interactive mockup (all screens in a browser, simulated) | `src/renderer/demo.html` | Works |

## Try it

You need Node.js 22 or newer.

```bash
npm install
npm run dev          # the desktop app (practice mode until the engine is installed)
```

Without the desktop app, for building the companion app or trying the tablet:

```bash
npm run build        # once, builds the tablet page
npm run server       # control server in practice mode; prints the pairing code
```

Then open the printed address on a tablet (`/remote`) or the developer test page (`/test`).

The interactive mockup: `npm run build`, then open `out/renderer/demo.html` through any static web server.

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
Streaming PC:  control server ─► controller ◄─ on-screen interface
                                         │
                                         └► engine (libobs) ─► YouTube, Facebook, Instagram…
ATEM Mini (video + audio) ─── USB-C ──────► engine
HyperDeck (video + audio) ─── capture card ► engine
```

Cameras plug into the ATEM, and camera switching happens on the ATEM itself. The app treats what arrives as video and audio sources, the way OBS does.

- `src/shared`: the protocol, state shape, presets. Used everywhere.
- `src/core`: the controller (every command goes through it), plus the simulated engine used in practice mode.
- `src/main`: Electron main process, control server, pairing, engine, saving to disk.
- `src/renderer`: the screens (main window, tablet remote, mockup).

## Security notes

- The control server listens on the local network only. Devices must pair with a 6-digit code shown on the streaming PC; each gets its own key, stored hashed.
- Stream keys stay on the streaming PC, encrypted with Windows' own protection, and are never sent to devices.
- Don't forward port 7420 on the router.

## License

GPL-2.0-or-later, because the engine (libobs) is GPL. See [LICENSE](LICENSE).
