// Section heights, heading line boxes and full-page screenshots, in either theme.
//
//   node scripts/line-boxes.mjs [url] [widths] [theme] [outDir] [cdpPort]
//   node scripts/line-boxes.mjs http://127.0.0.1:3120/ 320,390,768,900,1024,1440 light /tmp/lines
//
// The origin defaults to the port its two sibling harnesses default to; `pnpm start` honours
// `PORT`, so start it with `PORT=3120` or pass the URL you actually have.
//
// It exists because of one specific miss. The hero headline was styled `clamp(42px, 9.3vw,
// 148px)` inside a grid column, so the *viewport* set the size while a *column* set the width:
// the third line needed about 1,165px in a 706px box and broke `AUTONOMOUS` mid-word on every
// screen, including 1440px. An overflow sweep cannot see that — nothing leaves the viewport —
// and a screenshot at 390px does not show the desktop case. So this measures the thing that
// actually matters: the width of each text line inside its own heading box.
//
// The stuck-reveal check exists because of the second miss. The forcing style below is what makes
// a screenshot legible, and it also *hides* any element whose reveal never fired: `.architecture`
// was photographed fully present while every visitor with motion enabled saw nothing at all. So
// the probe runs first, unforced, and a stuck element fails the run.
//
// `captureBeyondViewport` is bounded at 16,000px. A 12,000px page at scale 0.32 is legible
// enough to judge rhythm; asking for the whole thing at 1x is how this harness once ate the
// disk.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const USAGE = 'usage: node scripts/line-boxes.mjs [url] [widths] [theme] [outDir] [cdpPort]'
const URL = process.argv[2] ?? 'http://127.0.0.1:3120/'
const WIDTHS = (process.argv[3] ?? '320,390,768,900,1024,1440').split(',').map(Number)
const THEME = process.argv[4] ?? 'light'
const OUT = process.argv[5] ?? '/tmp/ari-lines'
const PORT = Number(process.argv[6] ?? 9537)
// A non-numeric positional used to surface as "no DevTools page target on :NaN", which reads like
// a browser failure and is an argument failure — the sibling harnesses take the port second, not
// last, so passing widths there is an easy mistake to make. An empty URL is worse than either: it
// navigates to about:blank, measures a 606px page, and reports **clean**. Fail instead.
if (!URL.trim() || !/^https?:\/\//.test(URL)) {
  console.error(`bad arguments: url=${JSON.stringify(process.argv[2] ?? '')} must be an http(s) origin\n${USAGE}`)
  process.exit(2)
}
if (!WIDTHS.length || WIDTHS.some((w) => !Number.isFinite(w) || w <= 0) || !Number.isFinite(PORT) || PORT <= 0) {
  console.error(`bad arguments: widths=${JSON.stringify(process.argv[3] ?? '')} cdpPort=${JSON.stringify(process.argv[6] ?? '')}\n${USAGE}`)
  process.exit(2)
}
const PROFILE = `/tmp/ari-lines-${Date.now()}`
mkdirSync(OUT, { recursive: true })

const browser = spawn('chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', `--user-data-dir=${PROFILE}`, '--no-first-run',
  '--disable-crash-reporter', '--remote-allow-origins=*', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function devtools() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((e) => e.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('no DevTools page target')
}

const socket = new WebSocket(await devtools())
await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }) })

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (frame) => {
  const msg = JSON.parse(String(frame.data))
  if (msg.id !== undefined) pending.get(msg.id)?.(msg)
})
const send = (method, params = {}, timeoutMs = 25000) => new Promise((res, rej) => {
  const id = nextId++
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out after ${timeoutMs}ms`)) }, timeoutMs)
  pending.set(id, (msg) => { clearTimeout(timer); pending.delete(id); res(msg.result ?? {}) })
  socket.send(JSON.stringify({ id, method, params }))
})

const PROBE = `(() => {
  const rows = [];
  for (const h of document.querySelectorAll('h1, h2')) {
    const box = h.getBoundingClientRect();
    if (box.width < 10) continue;
    const lines = new Map();
    const walk = (node) => {
      if (node.nodeType === 3 && node.textContent.trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const seen = lines.get(rect.top);
          if (seen) seen.w = Math.max(seen.w, rect.right - rect.left);
          else lines.set(rect.top, { w: rect.right - rect.left, t: node.textContent.trim().slice(0, 34) });
        }
      } else node.childNodes.forEach(walk);
    };
    walk(h);
    for (const line of lines.values()) {
      rows.push({
        h: h.tagName + '.' + (((typeof h.className === 'string' ? h.className : '').split(/\\s+/)[0]) || '-'),
        line: line.t, w: Math.round(line.w), container: Math.round(box.width),
        over: Math.round(Math.max(0, line.w - box.width)),
      });
    }
  }
  const sections = [...document.querySelectorAll('main > section, main > div')].map((e) => ({
    cls: (typeof e.className === 'string' ? e.className : '').split(/\\s+/).slice(0, 2).join('.'),
    h: Math.round(e.getBoundingClientRect().height),
  }));
  // Text that is painted at zero opacity is content nobody can read. Run this BEFORE the forcing
  // style, or the harness photographs a page that looks complete and reports clean on a section
  // that never revealed at all — which is exactly how .architecture stayed invisible for a day.
  const stuck = [];
  for (const e of document.querySelectorAll('main *')) {
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const b = e.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    if (getComputedStyle(e).visibility === 'hidden') continue;
    let o = 1;
    for (let n = e; n; n = n.parentElement) o *= +getComputedStyle(n).opacity;
    if (o < 0.05) stuck.push({ cls: (typeof e.className === 'string' ? e.className : '').split(/\\s+/)[0] || e.tagName,
      owner: (() => { let n = e; while (n && !n.classList.contains('reveal') && !n.classList.contains('section-reveal') && n !== document.body) n = n.parentElement; return n === document.body ? '-' : ((typeof n.className === 'string' ? n.className : '').split(/\\s+/)[0] || n.tagName) + '.op=' + (+getComputedStyle(n).opacity).toFixed(2) })(),
      t: e.textContent.trim().slice(0, 30) });
  }
  return { total: Math.round(document.documentElement.scrollHeight), sections, rows, stuck };
})()`

// A viewport no device has produced 115 false STUCK readings at 320px: `width * 0.62` is 198px
// tall, and a section that is 3,000px high can never reach the reveal observer's 12 % threshold
// in it. These are roughly what the widths actually ship with.
const viewportHeight = (width) => width <= 500 ? Math.round(width * 2.1) : width <= 1024 ? Math.round(width * 1.3) : Math.round(width * 0.62)
let failures = 0
for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: viewportHeight(width), deviceScaleFactor: 1, mobile: width < 500 })
  await send('Page.navigate', { url: URL })
  await sleep(2600)
  await send('Runtime.evaluate', { expression: `localStorage.setItem('theme', ${JSON.stringify(THEME)}); document.documentElement.classList.toggle('dark', ${THEME === 'dark'}); document.documentElement.classList.toggle('light', ${THEME === 'light'}); 'ok'` })
  await sleep(1200)
  // `scroll-behavior: smooth` is the page's own rule and it makes a scripted scroll a lie: every
  // scrollTo restarts an animation, sections get skipped, and their observers never fire. Set it
  // to auto so a pass through the page fairly tests what actually reveals.
  await send('Runtime.evaluate', { expression: `(async () => { document.documentElement.style.scrollBehavior = 'auto'; const step = innerHeight * 0.7; for (let y = 0; y < document.body.scrollHeight; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 160)); } scrollTo(0, 0); await new Promise((r) => setTimeout(r, 400)); return 'ok' })()`, awaitPromise: true })
  await sleep(1000)
  // Measure first, force second: opacity, transform and clip-path do not change a layout box, so
  // the line widths are identical either way — but the stuck-reveal list is only honest while
  // nothing has been overridden.
  const evaluated = await send('Runtime.evaluate', { returnByValue: true, expression: PROBE })
  const result = evaluated.result?.value ?? {}
  // A beyond-viewport capture resizes the layout viewport, which re-triggers the reveal
  // observers and photographs them mid-transition — a page of invisible sections. Force the
  // end state for the picture, and drop the loader, which is fixed and covers the first fold.
  await send('Runtime.evaluate', { expression: `(() => { const style = document.createElement('style'); style.textContent = '.reveal, .section-reveal { opacity: 1 !important; transform: none !important; transition: none !important; clip-path: none !important; } .page-loader { display: none !important; }'; document.head.appendChild(style); return 'ok' })()` })
  await sleep(500)
  console.log(`\n=== ${width}px ${THEME}  total ${result.total}px`)
  for (const section of result.sections ?? []) console.log(`   ${String(section.h).padStart(5)}px  ${section.cls}`)
  const over = (result.rows ?? []).filter((row) => row.over > 1)
  failures += over.length
  if (over.length === 0) console.log('   ok   every heading line fits its container')
  for (const row of over) { console.log(`   OVER ${row.over}px  ${row.h}  "${row.line}"  line=${row.w} container=${row.container}`); }
  const stuck = result.stuck ?? []
  failures += stuck.length
  if (stuck.length === 0) console.log('   ok   no text left at zero opacity after a full scroll')
  for (const s of stuck) { console.log(`   STUCK ${String(s.cls).padEnd(18)} reveal-owner ${s.owner}  "${s.t}"`); }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(result.total ?? 1, 16000), scale: 0.32 } })
  if (shot.data) { writeFileSync(`${OUT}/${THEME}-${width}.png`, Buffer.from(shot.data, 'base64')); console.log(`   shot ${OUT}/${THEME}-${width}.png`) }
  else { failures++; console.log('   SCREENSHOT FAILED') }
}

socket.close()
browser.kill()
// Chromium is still writing to its profile when it is killed; removing the directory in the
// same tick races it and throws ENOTEMPTY.
await sleep(900)
rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
console.log(`\n${failures === 0 ? 'clean' : `${failures} problem(s)`}`)
process.exit(failures === 0 ? 0 : 1)
