// Every console and marketing route at every breakpoint, reporting only horizontal overflow
// that no ancestor already clips.
//
//   node scripts/responsive-sweep.mjs [origin] [cdpPort] [widths]
//   node scripts/responsive-sweep.mjs https://ari-zeta-seven.vercel.app 9471 320,390
//
// Two things this harness learned the hard way and encodes on purpose:
//
// 1. The first detector flagged any element whose box crossed the viewport, which counted
//    marquee tracks and `overflow-x: auto` tables as bugs — three phantom bugs, all of them
//    clipped by an ancestor. `clipped()` is why the report is short enough to read.
// 2. Width is not the product. A `.rail { height: 100vh }` appended after a `height: auto`
//    rule pushed the entire console below the fold on a phone while this script reported
//    0px overflow — a true statement about the wrong axis. Read a clean sweep as "nothing is
//    wider than the screen", then look at a screenshot.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:3120'
const PORT = Number(process.argv[3] ?? 9471)
const WIDTHS = (process.argv[4] ?? '320,390,768,1024,1440').split(',').map(Number)
const PATHS = [
  '/', '/docs',
  '/console', '/console/agents', '/console/agents/treasury-agent', '/console/approvals',
  '/console/audit', '/console/developers', '/console/policies', '/console/policies/usdc-treasury',
  '/console/risk', '/console/settings', '/console/wallets',
  '/console/transactions', '/console/transactions/txr_01a0e782-05cd-72a6-8155-0f49238fe520',
]
const SHOTS = '/tmp/ari-responsive'
const PROFILE = `/tmp/ari-sweep-${Date.now()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = spawn('chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-crash-reporter',
  '--remote-allow-origins=*', 'about:blank',
], { stdio: 'ignore' })

async function wsUrl() {
  // A cold headless start has taken well over 15s on this box while a desktop Chromium is
  // open. A short ceiling fails with "no DevTools page target", which reads like a browser
  // bug and is a waiting bug — and /tmp filling up looks identical from here.
  for (let i = 0; i < 120; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((e) => e.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error(`no DevTools page target on :${PORT} (is chromium installed, and is /tmp unworn out?)`)
}

const socket = new WebSocket(await wsUrl())
await new Promise((res, rej) => {
  socket.addEventListener('open', res, { once: true })
  socket.addEventListener('error', rej, { once: true })
})
let id = 1
const waiting = new Map()
socket.addEventListener('message', (frame) => {
  const m = JSON.parse(String(frame.data))
  if (m.id !== undefined) waiting.get(m.id)?.(m)
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = id++
    waiting.set(n, (msg) => { waiting.delete(n); resolve(msg.result ?? {}) })
    socket.send(JSON.stringify({ id: n, method, params }))
    // An unsettled top-level await lets Node exit with *no output at all*, which is
    // indistinguishable from a clean sweep. A bounded call turns it into a visible miss.
    setTimeout(() => { if (waiting.delete(n)) resolve({ __timeout: method }) }, 25_000)
  })

const HUNT = `(() => {
  const vw = document.documentElement.clientWidth;
  const clipped = (el) => { for (let p = el.parentElement; p; p = p.parentElement) {
    const ox = getComputedStyle(p).overflowX;
    if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') return true; } return false; };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 && !clipped(el)) {
      const cls = (typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : '').slice(0, 22);
      out.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' right=' + Math.round(r.right));
    }
  }
  return { vw, scroll: document.documentElement.scrollWidth, offenders: [...new Set(out)].slice(0, 4) };
})()`

mkdirSync(SHOTS, { recursive: true })
let failures = 0
let misses = 0
for (const w of WIDTHS) {
  for (const path of PATHS) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 500 ? 844 : 900, deviceScaleFactor: 2, mobile: w < 900 })
    await send('Page.navigate', { url: ORIGIN + path })
    await sleep(2100)
    const r = await send('Runtime.evaluate', { expression: HUNT, returnByValue: true })
    if (r.__timeout !== undefined) {
      misses += 1
      console.log(`MISS ${String(w).padStart(4)}px  ${path}  no ${r.__timeout} answer`)
      continue
    }
    const m = r.result?.value ?? {}
    const overflow = (m.scroll ?? 0) - (m.vw ?? 0)
    if (overflow > 1 || (m.offenders?.length ?? 0) > 0) {
      failures += 1
      console.log(`FAIL ${String(w).padStart(4)}px  ${path}  overflow ${overflow}px  ${m.offenders?.join(' | ') ?? ''}`)
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      if (typeof shot?.data === 'string') writeFileSync(`${SHOTS}/${w}${path.replace(/\//g, '_')}.png`, Buffer.from(shot.data, 'base64'))
    }
  }
  console.log(`  ^ ${w}px done (${PATHS.length} routes)`)
}
console.log(`\n${WIDTHS.length * PATHS.length} page/width combinations, ${failures} with overflow, ${misses} unhunted.`)
if (failures === 0 && misses === 0) console.log('Width only — see the note in this file about height.')
socket.close()
browser.kill()
// Chromium is still flushing into the profile when it is killed, so removing it immediately
// races the last write and raises ENOTEMPTY. A tidy-up that fails must not mask the report
// above it, hence the wait and the swallow rather than a bare rmSync.
await sleep(500)
try { rmSync(PROFILE, { recursive: true, force: true }) } catch {}
process.exit(failures + misses === 0 ? 0 : 1)
