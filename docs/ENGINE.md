# Video engine and inputs

## How the video and audio get in

Like OBS, this app does not switch cameras. Cameras plug into the ATEM and are switched there. The app takes in what the ATEM or HyperDeck sends, as sources you can put in scenes.

| Device | How it connects | Video source | Audio |
| --- | --- | --- | --- |
| ATEM Mini, Mini Pro, Mini Extreme | USB-C to the PC | Shows up as a webcam named "Blackmagic Design" (libobs `dshow_input`) | Shows up as a USB audio input (`wasapi_input_capture`) |
| HyperDeck, or a larger ATEM (Television Studio, Constellation) | HDMI or SDI out into a Blackmagic DeckLink card or UltraStudio box | libobs `decklink-input` | Comes in with the picture, on the same device |
| Either one, through a USB HDMI capture stick | USB | Webcam (`dshow_input`) | Comes in with the picture |

In the app:

- **+ Add source → Video input** picks one of the devices the PC can see. One device can appear in many scenes; the engine opens it once and shares it.
- **+ Add audio** adds a mixer channel: an audio input (a mic, the ATEM Mini's USB audio), the sound from a video input (HyperDeck or capture card), or the PC's desktop sound.
- **Settings → Video and audio inputs** lists what the PC can see, with a "Look again" button after plugging something in.

Device ids are prefixed by type (`dshow:`, `decklink:`, `wasapi:`) so the engine knows which libobs source to make.

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

- First run on Windows with obs-studio-node, an ATEM Mini over USB-C and a HyperDeck through a DeckLink card; fix whatever the API differs on (device property names in particular).
- Real video in the Preview and Live monitors (`OBS_content_createSourcePreviewDisplay`). Today the monitors show a drawing of each scene.
- Audio peak meters from libobs volmeters (today: simulated levels).
- A vertical scene layout for Instagram.
- Position and size of each source on the canvas (today every source fills the picture).
