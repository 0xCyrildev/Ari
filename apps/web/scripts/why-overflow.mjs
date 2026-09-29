// Which box is actually too wide? Walk a suspect element's ancestor chain and print the
// measurements, so a responsive fix is aimed at a cause rather than at a guess.
//
//   node scripts/why-overflow.mjs [origin] [path] [width] [selector]
//   node scripts/why-overflow.mjs http://127.0.0.1:3120 /console/agents/treasury-agent 320 .state
//
// This is what found the 320px case: `span.state right=334` on a 320px screen, and six
// plausible boxes above it. The chain said `dl.kv` had `grid-template-columns: 132px 84px`
// — the label column is fixed, so the value column was what starved — and the value inside
// it was 140px of `white-space: nowrap` monospace. Without this the fix would have been a
// media query aimed at whatever looked nearest.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:3120'
const PATH = process.argv[3] ?? '/console/agents/treasury-agent'
const W = Number(process.argv[4] ?? 320)
const SELECTOR = process.argv[5] ?? '.state'
const PORT = Number(process.argv[6] ?? 9481)
if (!Number.isFinite(W) || W <= 0 || !Number.isFinite(PORT) || PORT <= 0) {
  console.error(`bad arguments: width=${JSON.stringify(process.argv[4] ?? '')} cdpPort=${JSON.stringify(process.argv[6] ?? '')}\nusage: node scripts/why-overflow.mjs [origin] [path] [width] [selector] [cdpPort]`)
  process.exit(2)
}
const PROFILE = `/tmp/ari-why-${Date.now()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = spawn('chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-crash-reporter',
  '--remote-allow-origins=*', 'about:blank',
], { stdio: 'ignore' })

async function wsUrl() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((e) => e.type === 'page')
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error(`no DevTools page target on :${PORT}`)
}
const socket = new WebSocket(await wsUrl())
await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }) })
let id = 1
const waiting = new Map()
socket.addEventListener('message', (f) => { const m = JSON.parse(String(f.data)); if (m.id !== undefined) waiting.get(m.id)?.(m) })
const send = (method, params = {}) => new Promise((res) => {
  const n = id++
  waiting.set(n, (m) => { waiting.delete(n); res(m.result ?? {}) })
  socket.send(JSON.stringify({ id: n, method, params }))
})

const EXPR = `(() => {
  const el = document.querySelector(${JSON.stringify(SELECTOR)});
  if (!el) return { error: ${JSON.stringify(SELECTOR)} + ' matched nothing on this page' };
  const chain = [];
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    chain.push({
      node: n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/)[0] : ''),
      rect: [Math.round(r.left), Math.round(r.right), Math.round(r.width)],
      display: cs.display, ws: cs.whiteSpace, minW: cs.minWidth, gtc: cs.gridTemplateColumns.slice(0, 40), ovf: cs.overflowX,
    });
  }
  return { vw: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, text: el.textContent.trim().slice(0, 40), chain };
})()`

await send('Emulation.setDeviceMetricsOverride', { width: W, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: ORIGIN + PATH })
await sleep(2200)
const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true })
const m = r.result?.value ?? {}
if (m.error) console.log(m.error)
else {
  console.log(`${PATH} at ${W}px — viewport ${m.vw}, document ${m.scroll}, suspect "${m.text}"`)
  for (const c of m.chain) {
    console.log(`  ${String(c.rect[0]).padStart(5)}→${String(c.rect[1]).padEnd(5)} w=${String(c.rect[2]).padStart(4)}  ${c.node.padEnd(22)} display=${c.display.padEnd(6)} min-width=${c.minW.padEnd(6)} ws=${c.ws.padEnd(7)} grid=${c.gtc}  overflow-x=${c.ovf}`)
  }
}
socket.close()
browser.kill()
await sleep(500)
try { rmSync(PROFILE, { recursive: true, force: true }) } catch {}
process.exit(0)
