/**
 * Developer test page at http://<streaming-pc>:7420/test for the companion
 * app team: pair, send any message, and watch what comes back.
 */
export const TEST_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Control API test page</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --fg:#1d1d1b; --muted:#6b6b66; --line:#d8d8d2; --accent:#2a6fdb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecece8; --muted:#a3a39c; --line:#3a3a36; --accent:#6aa0ff; } }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--fg); }
  main { max-width: 960px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
  h1 { font-size: 18px; margin: 0; }
  section { border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; gap: 8px; }
  input, textarea, select, button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
  button { cursor: pointer; } button.primary { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  textarea { min-height: 110px; font-family: ui-monospace, monospace; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  pre { margin: 0; max-height: 360px; overflow: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Control API test page</h1>
  <p class="muted">For building the companion app or a stream deck. Messages are JSON over the WebSocket at <code>/ws</code>. See docs/PROTOCOL.md.</p>
  <section>
    <div class="row">
      <input id="code" placeholder="Pairing code" size="10" inputmode="numeric">
      <input id="name" placeholder="Device name" value="Test page">
      <select id="role"><option>remote</option><option>buttons</option><option>data</option><option>viewer</option></select>
      <button class="primary" id="pair">Pair</button>
      <button id="forget">Forget key</button>
      <span id="status" class="muted">Not connected</span>
    </div>
  </section>
  <section>
    <div class="row">
      <button data-ex='{"type":"command","id":"1","action":"state.get"}'>state.get</button>
      <button data-ex='{"type":"data","set":{"team1.score":3,"guest.name":"Sam"}}'>data</button>
      <button data-ex='{"type":"command","id":"2","action":"layer.setVisible","params":{"sceneId":"live","layerId":"live-score","visible":true}}'>layer.setVisible</button>
      <button data-ex='{"type":"command","id":"3","action":"scene.preview","params":{"sceneId":"brb"}}'>scene.preview</button>
      <button data-ex='{"type":"command","id":"4","action":"scene.goLive"}'>scene.goLive</button>
    </div>
    <textarea id="msg">{"type":"data","set":{"team1.score":3}}</textarea>
    <div class="row"><button class="primary" id="send">Send</button></div>
  </section>
  <section>
    <div class="row"><strong>Messages</strong><label class="muted"><input type="checkbox" id="stats"> show stats events</label></div>
    <pre id="log"></pre>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id)
const KEY = 'streaming-app-test-token'
let ws
function log(dir, obj) {
  if (obj && obj.name === 'stats' && !$('stats').checked) return
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  $('log').textContent = dir + ' ' + text + '\\n\\n' + $('log').textContent.slice(0, 20000)
}
function connect(first) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws')
  ws.onopen = () => { $('status').textContent = 'Connected'; ws.send(JSON.stringify(first)) }
  ws.onclose = (e) => { $('status').textContent = 'Closed: ' + (e.reason || e.code) }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.type === 'paired') { try { localStorage.setItem(KEY, m.token) } catch {} }
    if (m.type === 'welcome') $('status').textContent = 'Connected as ' + m.name + ' (' + m.role + ')'
    log('<-', m)
  }
}
$('pair').onclick = () => connect({ type: 'pair', code: $('code').value, name: $('name').value, role: $('role').value })
$('forget').onclick = () => { try { localStorage.removeItem(KEY) } catch {}; $('status').textContent = 'Key forgotten' }
$('send').onclick = () => {
  let m; try { m = JSON.parse($('msg').value) } catch { return log('!!', 'Not valid JSON') }
  if (!ws || ws.readyState !== 1) return log('!!', 'Not connected')
  ws.send(JSON.stringify(m)); log('->', m)
}
document.querySelectorAll('[data-ex]').forEach((b) => b.onclick = () => { $('msg').value = JSON.stringify(JSON.parse(b.dataset.ex), null, 2) })
let saved = null; try { saved = localStorage.getItem(KEY) } catch {}
if (saved) connect({ type: 'hello', token: saved })
</script>
</body>
</html>`
