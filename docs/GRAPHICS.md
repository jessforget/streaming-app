# Graphics from another computer

Your gfx app runs on another computer on the same network. It shows its
graphics as a web page, and the streaming app adds that page as a
**Graphics (network)** source, see-through over the cameras.

The gfx app controls everything: what shows, when it animates in and out,
names and scores. The streaming app only loads the page and shows it.

Works in the desktop version (`npm run desktop`, or "Start Streaming App
(desktop)"). The web version in Chrome can't show another site's picture.

## What the gfx app's page must do

1. **Be a web address on the network**, like `http://192.168.101.50:8080/live`.
   Give the gfx laptop a fixed address on the router so it never changes.
2. **Have a see-through background**: `background: transparent` on the page.
   Whatever it draws shows; everything else lets the cameras show through.
3. **Be laid out at 1920 x 1080** (or 1280 x 720 if you pick that size in the
   source's settings). It is scaled to the stream's size.
4. **Run on its own**: no pop-ups, log-ins or "click to start" buttons, because
   nobody can click it. Sound from the page is not played.

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

## Sample gfx app

`examples/gfx-app` is a tiny gfx app to start from: a lower third that slides
in, and a control page to type a name and show or hide it. No installs needed:

```
node examples/gfx-app/server.cjs
```

It prints the two addresses: `/live` goes into the streaming app, `/control`
opens in a browser on the graphics laptop (or a phone).
