// One browser session, several console routes, connected then unconnected.
//   node /tmp/probe2.mjs <bearer> [path ...]
import { spawn } from 'node:child_process'

const PORT = 9422
const CRED = process.argv[2] ?? ''
const PATHS = process.argv.slice(3)
if (CRED.length === 0 || PATHS.length === 0) {
  console.error('usage: node probe2.mjs <bearer> /console/settings ...')
  process.exit(2)
}

const browser = spawn('chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu',
  `--user-data-dir=/tmp/ari-cdp-${Date.now()}`, '--no-first-run', '--disable-crash-reporter',
  '--remote-allow-origins=*', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
      const page = list.find((e) => e.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    if (i === 5) await fetch(`http://localhost:${PORT}/json/new?url=about:blank`, { method: 'PUT' }).catch(() => {})
    await sleep(250)
  }
  throw new Error('no DevTools page target')
}

const socket = new WebSocket(await wsUrl())
await new Promise((res, rej) => {
  socket.addEventListener('open', res, { once: true })
  socket.addEventListener('error', rej, { once: true })
})
let id = 1
const waiting = new Map()
const errors = []
socket.addEventListener('message', (frame) => {
  const m = JSON.parse(String(frame.data))
  if (m.id !== undefined) {
    waiting.get(m.id)?.(m)
    waiting.delete(m.id)
  } else if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
    errors.push(m.params.entry.text.slice(0, 120))
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = id++
    const timer = setTimeout(() => { waiting.delete(n); reject(new Error(`${method} timed out`)) }, 25_000)
    waiting.set(n, (m) => { clearTimeout(timer); resolve(m.result ?? m) })
    socket.send(JSON.stringify({ id: n, method, params }))
  })
const evalJs = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value ?? null

await send('Log.enable')
await send('Page.enable')
await send('Runtime.enable')

const visit = async (path, label) => {
  await send('Page.navigate', { url: `http://127.0.0.1:3100${path}?${label}${Date.now()}` })
  await sleep(6000)
  const text = String(await evalJs('document.body.innerText'))
  const banner = String(await evalJs('document.querySelector(".connect-notice")?.innerText ?? "(no banner)"'))
  const state = String(await evalJs('document.querySelector(".connect-state .label")?.innerText ?? "(none)"'))
  const bad = String(await evalJs(`JSON.stringify(performance.getEntriesByType('resource').filter((e)=>e.name.includes('/api/ari')&&e.responseStatus>=400).map((e)=>e.name.slice(33)+' '+e.responseStatus))`))
  const body = text.replace(/\s+/g, ' ').replace('ARI / CONSOLE', '').replace(/(OVERVIEW|AGENTS|POLICIES|TRANSACTIONS|APPROVALS|RISK|WALLETS|AUDIT LOG|DEVELOPERS|SETTINGS|MARKETING SITE ↗|CONNECTED TENANT|SAMPLE TENANT|RE-READ|FORGET CREDENTIAL|Live tenant[^·]*·? ?reads and writes go to this deployment|Sample tenant[^.]*\.)+/g, '').trim()
  console.log(`\n### ${label} :: ${path}`)
  console.log(`chip: ${state} | banner: ${banner.slice(0, 46)}`)
  console.log(`http>=400: ${bad}`)
  console.log(`copy: ${body.slice(0, 430)}`)
}

console.log('=== CONNECTED ===')
await send('Page.navigate', { url: 'http://127.0.0.1:3100/console' })
await sleep(5000)
await evalJs(`sessionStorage.setItem('ari.console.credential', ${JSON.stringify(CRED)})`)
for (const path of PATHS) await visit(path, 'on')

console.log('\n=== UNCONNECTED (credential forgotten) ===')
await evalJs(`sessionStorage.removeItem('ari.console.credential')`)
for (const path of PATHS) await visit(path, 'off')

console.log(`\n=== page errors seen (${errors.length}) ===`)
console.log([...new Set(errors)].slice(0, 8).join('\n') || '(none)')
socket.close()
browser.kill('SIGKILL')
process.exit(0)
