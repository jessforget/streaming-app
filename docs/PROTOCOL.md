# Control protocol (version 1)

Every device on the local network talks to the streaming app the same way: the tablet remote, the companion app, and a future stream deck. Anything a button in the app can do, a paired device can do too, if its role allows it.

- **Transport:** JSON text messages over one WebSocket.
- **Address:** `ws://<streaming-pc>:7420/ws`. The streaming PC shows its address under **Settings → Remote and devices**.
- **Test page:** `http://<streaming-pc>:7420/test` lets you pair, send any message and see the replies.
- **Info:** `GET http://<streaming-pc>:7420/api/info` returns `{ "app": "streaming-app", "version": "…", "protocol": 1, "ws": "/ws" }`.

The source of truth is [`src/shared/protocol.ts`](../src/shared/protocol.ts). The full app state shape is in [`src/shared/state.ts`](../src/shared/state.ts).

## 1. Pairing (once per device)

The streaming PC shows a 6-digit code and a QR code. Send the code within 10 seconds of connecting:

```json
{ "type": "pair", "code": "482913", "name": "Scoreboard PC", "role": "data" }
```

Reply:

```json
{ "type": "paired", "v": 1, "deviceId": "…", "token": "64 hex characters", "role": "data" }
```

Keep the `token`: it is this device's key. After pairing, the app sends `welcome` (below). Each code works once. Five wrong codes close the connection, and ten wrong codes in a minute change the code.

## 2. Connecting (every time after that)

```json
{ "type": "hello", "token": "<your token>" }
```

Reply, with the whole current state:

```json
{ "type": "welcome", "v": 1, "deviceId": "…", "name": "Scoreboard PC", "role": "data", "state": { … } }
```

An unknown or removed key closes the connection with code `4004` (unknown) or `4003` (removed on the streaming PC). Pair again.

## 3. Roles

| Role | Can do | Typical device |
| --- | --- | --- |
| `remote` | Everything except settings | Tablet remote |
| `buttons` | Press buttons (scenes, sources on/off, audio, stream, record); no data, no settings | Stream deck |
| `data` | Send and clear data fields only | Companion app |
| `viewer` | Read state and events only | Producer's phone, a tally light |

The person at the streaming PC can change a device's role or remove it at any time; it takes effect at once. Settings (stream keys, platforms, pairing) can only be changed on the streaming PC itself.

## 4. Commands

```json
{ "type": "command", "id": "42", "action": "scene.preview", "params": { "sceneId": "brb" } }
```

Reply (the `id` comes back so you can match it):

```json
{ "type": "result", "id": "42", "ok": true }
{ "type": "result", "id": "42", "ok": false, "error": "No scene with id brb" }
```

Errors are plain words you can show to a person.

There are no camera switching commands: cameras are switched on the ATEM itself. The app takes the ATEM's (or a HyperDeck's) video and audio in as sources, like OBS.

| Action | Params | Role needed |
| --- | --- | --- |
| `state.get` | none | any |
| `scene.preview` | `{ "sceneId": "brb" }` | remote, buttons |
| `scene.program` | `{ "sceneId": "brb" }` (on air now) | remote, buttons |
| `scene.goLive` | none (Preview goes on air) | remote, buttons |
| `transition.set` | `{ "kind": "cut" \| "fade", "durationMs": 300 }` | remote, buttons |
| `layer.setVisible` | `{ "sceneId", "layerId", "visible": true }` | remote, buttons |
| `audio.setVolume` | `{ "sourceId": "mic", "volume": 0.8 }` (0 to 1) | remote, buttons |
| `audio.setMuted` | `{ "sourceId": "mic", "muted": true }` | remote, buttons |
| `audio.muteAll` | none | remote, buttons |
| `stream.start` / `stream.stop` | none | remote, buttons |
| `record.start` / `record.stop` | none | remote, buttons |
| `data.set` | `{ "values": { "team1.score": 3 } }` | remote, data |
| `data.clear` | `{ "keys": ["team1.score"] }`, or `{}` for all | remote, data |

Changing the setup (scenes, sources, audio channels) is for the streaming PC only, like settings:

| Action | Params |
| --- | --- |
| `scene.add` | `{ "name": "Interview" }` → `{ "sceneId" }` |
| `scene.rename` | `{ "sceneId", "name" }` |
| `scene.remove` | `{ "sceneId" }` (not the scene on air, not the last one) |
| `layer.add` | `{ "sceneId", "kind": "video" \| "image" \| "text" \| "browser" \| "media" \| "screen" \| "window", "name"?, "device"?, "text"?, "url"?, "placement"?, "at"? }` → `{ "layerId" }`. New sources go on top; `"at": "bottom"` puts one behind everything (how the app adds cameras). |
| `layer.update` | `{ "sceneId", "layerId", "name"?, "device"?, "text"?, "url"?, "placement"? }`. `placement`: `full`, `center`, `lower-third`, `top`, `top-left`, `top-right`, `bottom-right`. |
| `layer.move` | `{ "sceneId", "layerId", "direction": "up" \| "down" }` |
| `layer.remove` | `{ "sceneId", "layerId" }` |
| `audio.add` | `{ "name", "kind": "device" \| "video" \| "desktop", "device"?, "channels"?, "syncOffsetMs"? }` → `{ "sourceId" }`. `channels` = one input (`[3]`, a mic) or a pair (`[9, 10]`) of a multichannel interface, counted from 1. `syncOffsetMs` = 0 to 5000 (holds the sound back). |
| `audio.update` | `{ "sourceId", "name"?, "device"?, "channels"?, "syncOffsetMs"? }`. A new device starts again from its first pair. |
| `audio.remove` | `{ "sourceId" }` |
| `inputs.refresh` | none (look for capture and audio devices again) |

`device` ids come from `state.inputs.video` and `state.inputs.audio`. Each audio device has its real name, its `driver` (`wasapi` or `asio`), and when known its `channels` count and `channelNames`. The list updates by itself when a device is plugged in or unplugged.

## 5. Data fields (companion app)

Short form of `data.set`:

```json
{ "type": "data", "id": "7", "set": { "team1.score": 3, "guest.name": "Sam Rivera", "clock.running": true } }
```

- Field names: letters, digits, `.`, `-`, `_`; up to 64 characters. Use dots to group (`team1.score`).
- Values: text (up to 2000 characters), a number, `true`/`false`, or `null`.
- Up to 500 fields.
- A text layer whose text contains `{team1.score}` shows the value and changes the moment it arrives.
- The app shows each field, its value and which device sent it, under **Data fields**.

## 6. Events (pushed to every connected device)

The whole state, after any change (at most every 30 ms):

```json
{ "type": "event", "name": "state", "state": { … } }
```

Health once a second while the app runs:

```json
{ "type": "event", "name": "stats", "stats": { "health": "good", "message": "Healthy, 0 dropped frames", "fps": 30, "cpu": 21, "droppedFrames": 0, "totalFrames": 5400, "requiredKbps": 4660, "audioLevels": { "mic": 0.62 } } }
```

Something that went wrong on its own (a stream dropped, a device was unplugged), in words you can show:

```json
{ "type": "event", "name": "notice", "message": "ZOOM L-12 Audio · Microphone was unplugged" }
```

Useful parts of `state` for a stream deck's button lights:

- `programSceneId` / `previewSceneId`: which scene is on air / next.
- `scenes[].layers[].visible`: which sources are showing.
- `stream.live`, `recording.active`.
- `audio[].muted`.

Devices never receive stream keys or the pairing code.

## The main window (streaming PC only)

The main window, opened at `http://localhost:7420` on the streaming PC, sends `{ "type": "local", "studio": true }` instead of pairing. The server accepts it only from this PC and from its own page (checked by address, `Host` and `Origin`). The first main window runs the video (`"studio": true` in `welcome`) and reports with `inputs.report` (the devices its browser can open) and `studio.report` (frame rate and audio levels). It sends the picture and sound on a second WebSocket, `/media?kind=stream|record`. Other devices can't do any of this.

## 7. Limits

- Messages up to 64 KB, up to 60 per second per connection.
- Local network only. Don't forward port 7420 on the router.

## 8. Versions

Every `paired` and `welcome` message carries `v`. New commands and new state fields may be added within version 1; existing ones won't change meaning. A breaking change becomes version 2.

## Example: a minimal companion app (Node.js)

```js
import WebSocket from 'ws'
const ws = new WebSocket('ws://192.168.1.20:7420/ws')
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: process.env.STREAMING_TOKEN })))
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'data', set: { 'team1.score': 3 } }))
  if (m.type === 'result' && !m.ok) console.error(m.error)
})
```
