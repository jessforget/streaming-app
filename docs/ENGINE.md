# Video engine and ATEM

## How the video gets in

The ATEM switches cameras. On an ATEM Mini, Mini Pro or Mini Extreme, the program picture reaches the streaming PC over the USB-C cable, where Windows sees it as a webcam named "Blackmagic Design". The app's **ATEM program feed** layer picks that webcam up.

Larger ATEM models (Television Studio, Constellation) have no USB webcam output. Their program SDI or HDMI output goes into a Blackmagic DeckLink card or UltraStudio box instead; the layer then uses libobs's DeckLink source (Phase 2).

## How camera switching works

Camera buttons in the app, on the tablet and on a stream deck all go through [`NetworkAtemLink`](../src/main/atem/atemLink.ts). It uses [atem-connection](https://github.com/nrkno/sofie-atem-connection), an open-source Node.js implementation of the ATEM network protocol (UDP port 9910). The ATEM and the PC must be on the same network: plug the ATEM's Ethernet port into the same router.

Set the ATEM's IP address in **Settings → ATEM**. Find it in ATEM Setup under Configure, Network.

## The video engine (libobs)

Capture, mixing, encoding, streaming and recording come from OBS's own engine, libobs, through **obs-studio-node**, the Node.js binding Streamlabs maintains. The code is in [`src/main/engine/obsEngine.ts`](../src/main/engine/obsEngine.ts).

**Status: not yet run on Windows.** The engine code follows obs-studio-node's API but has not been tested against a real build. The first Windows run (Phase 1) will need small fixes. Until obs-studio-node is installed, the app runs in **practice mode** with a simulated engine: every button works, but nothing is captured or sent. The top bar says "Practice mode" so this is never a surprise.

### Installing obs-studio-node (Windows)

The version on the public npm registry is old. Streamlabs publishes current Windows builds with each [obs-studio-node release](https://github.com/stream-labs/obs-studio-node/releases).

1. Download the Windows (win64) release archive for the latest release.
2. In this repository: `npm install <path-to-the-downloaded-tar.gz>`.
3. Run `npm run dev`. The top bar no longer says "Practice mode".

To force practice mode anyway: set `STREAMING_ENGINE=simulated`.

## Encoders and quality

**Low**, **Medium** and **High** in Go Live settings set resolution, frame rate and bitrate ([`src/shared/presets.ts`](../src/shared/presets.ts)). The engine picks the best encoder the PC has, in this order: NVIDIA NVENC, AMD AMF, Intel QuickSync, then x264 on the processor.

## Streaming to several platforms at once (optional)

Up to 3 platforms can be on at once. Each gets its own RTMP or RTMPS output. YouTube and Facebook take the wide picture. Instagram is vertical: a separate vertical layout is planned for Phase 2; until then Instagram gets the wide picture. The health bar shows the upload speed needed for all of them.

## Remaining engine work (Phase 1 and 2)

- First run on Windows with obs-studio-node and an ATEM Mini; fix whatever the API differs on.
- Real video in the Preview and Live monitors (`OBS_content_createSourcePreviewDisplay`). Today the monitors show a drawing of each scene.
- Audio peak meters from libobs volmeters (today: simulated levels).
- A vertical scene layout for Instagram.
- DeckLink input for larger ATEM models.
