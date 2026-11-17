# Graphics from another computer

Your gfx app runs on another computer on the same network. It shows its
graphics as a web page, and the streaming app adds that page as a
**Graphics (network)** source, see-through over the cameras.

The gfx app controls everything: what shows, names and scores. The streaming
app loads the page and shows it, and tells the page when it goes on and off
the stream, so the page can animate in, or start a video, at that moment.

Put the source in the **Overlay** (in the side panel): it then sits on top of
every scene, in Preview and Live, and switching scenes doesn't touch it. The
**Overlay** button next to Transition (or the O key) turns it on and off, like
the keyer button on an ATEM. A scene can **Hide the Overlay** (for "Starting
soon" or "Ending"): tick it under that scene's sources.

Works in the desktop version (`npm run desktop`, or "Start Streaming App
(desktop)"). The web version in Chrome can't show another site's picture.

## What the gfx app's page must do

1. **Be a web address on the network**, like `http://192.168.101.50:8765/live`.
   Give the gfx laptop a fixed address on the router so it never changes.
2. **Have a see-through background**: `background: transparent` on the page.
   Whatever it draws shows; everything else lets the cameras show through.
3. **Be laid out at 1920 x 1080** (or 1280 x 720 if you pick that size in the
   source's settings). It is scaled to the stream's size.
4. **Run on its own**: no pop-ups, log-ins or "click to start" buttons, because
   nobody can click it. Sound the page plays itself is not heard; a page sends
   sound to the stream with `window.streamerAudio` (below).
5. **Optional: start when the stream puts it live.** The streaming app tells the
   page when a scene with it goes live, or the Overlay is switched on, and when
   it comes off:

   ```js
   window.streamerLive            // true while the graphics are on the stream
   window.addEventListener('streamer:live', (e) => {
     if (e.detail.live) playIn()  // animate in, start the video...
     else reset()                 // off the stream: ready to play in again next time
   })
   ```

## How it behaves

- The page is loaded once over the network and drawn on the streaming PC, so
  Wi-Fi only carries the gfx app's own updates (a new name, a score).
- Only the parts of the page that change are copied each frame: a still lower
  third costs nothing.
- The status light in the source list says **Connected**, **Connecting…** or
  **Can’t reach**. The app checks the address every 5 seconds. After 10
  seconds without an answer it takes the graphics off (so nothing out of date
  stays on air) and says so once. When the gfx laptop answers again the page
  loads again by itself.
- **Reload page** in the source's settings loads it again, for when you changed
  the design.

## The gfx app (gfx-app)

`gfx-app` is our own gfx app, for a Windows laptop. Start it with **Start Gfx
App.bat** (or `npm run gfx`). Its window fits a laptop screen:

- **Rundown** (left): lower thirds, videos, photo slideshows, and windows from
  the laptop (PowerPoint, Word...). **+ Add**, or drag videos and photos in from
  Explorer. Click an item to put it in Preview, double-click to take it on air.
- **Preview** and **On air** (middle), with **Take** (space bar), **Hide** (Esc)
  and **Next** (arrow keys).
- **Settings** (right) for the item in Preview:
  - Lower thirds: name, title, and the look of every lower third (four styles,
    font, position, sizes, length, colours, how long it stays on, animation).
  - Videos: full screen or a box, loop / play once then hide / stay on the last
    frame.
  - Slideshows: seconds per photo, fade or cut, start again / stay on the last
    / hide at the end.
  - Windows: which window, full screen or a box.
  - **Start when the stream puts it live** (on by default): taken items wait
    for the streaming app to put the graphics live, then animate in or start
    playing. Off the stream, they reset, so they start again next time.
- The top bar says whether the streaming app is connected and has the graphics
  live, and shows the address to add in the streaming app (`http://<laptop>:8765/live`).

How each kind travels: lower thirds, videos and photos are drawn by the page on
the streaming PC, sharp and see-through; the files are fetched from the gfx
laptop. A window is sent like a live camera (WebRTC): more network, and a
fraction of a second late, so a network cable helps. Whole screens are listed
too: a PowerPoint slide show on a second screen is easiest sent as that screen.

**Finding it.** In the source's settings, **Find gfx apps on the network**
asks every address on the streaming PC's own network (ports 8765 to 8767) for
the gfx app's `/api/info` and lists what answers; **Test** checks one address.
If nothing answers, the usual cause is Windows Firewall on the gfx PC: the gfx
app checks its own rules and shows **Let the streaming PC in**, which adds one
rule letting PCs on the same network in (Windows asks to confirm).

**Sound.** A video's sound (the "Send its sound to the stream" setting, on by
default) goes into the streaming app's mixer, not the streaming PC's speakers.
Inside the streaming app the page has `window.streamerAudio.connect(offerSdp)`,
which returns the answer SDP for one WebRTC audio track; the gfx app's page
mixes each playing video into that track. In the streaming app it is a channel
named after the source ("Gfx (sound)"), heard while the source is on air, with
"Play its sound" and a volume in the source's settings.

The show (rundown and look) is saved in the gfx app's settings folder
(`%APPDATA%\Gfx app\gfx-show.json`).

Without the window (only Node.js): `node gfx-app/server.cjs --open` runs the
same server and opens the operator page in a browser. Videos and photos can't
be picked there, and windows can't be sent.
