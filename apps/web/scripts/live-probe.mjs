// Drive headless Chromium over the DevTools WebSocket and report what the console page really
// renders after a credential is stored. No dependency: Node ships a WebSocket client, and every
// call is bounded by a timeout, because a CDP command that never answers should fail this run
// loudly rather than hang it.
//
//   node /tmp/probe.mjs <credential>
import { spawn } from 'node:child_process'

const PORT = 9411
const CRED = process.argv[2] ?? ''
if (CRED.length === 0) {
  console.error('usage: node probe.mjs <bearer>')
  process.exit(2)
}

const browser = spawn(
  'chromium',
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--user-data-dir=/tmp/ari-cdp-' + Date.now(),
    '--no-first-run',
    '--disable-crash-reporter',
    '--remote-allow-origins=*',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targetUrl() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
      const page = list.find((entry) => entry.type === 'page')
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
      if (attempt === 3) {
        await fetch(`http://localhost:${PORT}/json/new?url=about:blank`, { method: 'PUT' }).catch(() => undefined)
      }
    } catch {
      // not listening yet
    }
    await sleep(250)
  }
  throw new Error('chromium never exposed a DevTools page target')
}

const socket = new WebSocket(await targetUrl())
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const events = []
socket.addEventListener('message', (frame) => {
  const message = JSON.parse(String(frame.data))
  if (message.id !== undefined) {
    const waiter = pending.get(message.id)
    if (waiter !== undefined) {
      pending.delete(message.id)
      waiter(message)
    }
  } else if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled' || message.method === 'Log.entryAdded') {
    events.push({ method: message.method, params: message.params })
  }
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} did not answer within 25s`))
    }, 25_000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message.result ?? message)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

const evaluate = async (expression) => {
  const answer = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return answer.result?.value ?? null
}

await send('Log.enable')
await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:3100/console?fresh=${Date.now()}` })
await sleep(4000)
await evaluate(`sessionStorage.setItem('ari.console.credential', ${JSON.stringify(CRED)})`)
await send('Page.navigate', { url: `http://127.0.0.1:3100/console?fresh=${Date.now()}` })
await sleep(20000)

console.log('--- storage after reload ---')
console.log('stored:', String(await evaluate('sessionStorage.getItem("ari.console.credential")')))
console.log('keys:', String(await evaluate('JSON.stringify(Object.keys(sessionStorage))')))
console.log('direct fetch from page context:', String(await evaluate(`
  fetch('/api/ari/v1/summary', { headers: { authorization: 'Bearer ' + (sessionStorage.getItem('ari.console.credential') || '') } })
    .then((response) => response.text().then((body) => response.status + ' ' + body.slice(0, 120)))
    .catch((error) => 'fetch threw ' + String(error))
`)))
console.log('--- rendered text ---')
console.log(String(await evaluate('document.body.innerText.slice(0, 1400)')))
console.log('--- fetches the page made ---')
console.log(
  String(
    await evaluate(
      `performance.getEntriesByType('resource').filter(e => e.name.includes('/api/ari')).map(e => e.name.replace('http://127.0.0.1:3100','') + ' ' + e.responseStatus).join('\\n')`,
    ),
  ),
)
console.log('--- requests that failed ---')
console.log(String(await evaluate(`JSON.stringify(performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => e.name.slice(24) + ' ' + e.responseStatus))`)))
console.log('scripts on page:', String(await evaluate(`JSON.stringify([...document.scripts].map((s) => s.src.slice(24)).slice(0, 6))`)))
console.log('--- hydration ---')
console.log('buttons:', String(await evaluate('document.querySelectorAll("button").length')))
console.log('react root:', String(await evaluate(`Object.keys(document.getElementById('ari-credential') || {}).filter((k) => k.indexOf('__react') === 0).length`)))
console.log('form present:', String(await evaluate('!!document.querySelector(".connect-form")')))
console.log('forget present:', String(await evaluate('document.body.innerText.indexOf("FORGET") >= 0')))
console.log('--- console and exceptions ---')
for (const event of events.slice(0, 30)) {
  const detail = event.params ?? {}
  const text =
    event.method === 'Runtime.exceptionThrown'
      ? `EXCEPTION ${detail.exceptionDetails?.text ?? ''} ${detail.exceptionDetails?.exception?.description ?? ''}`
      : event.method === 'Log.entryAdded'
        ? `LOG[${detail.entry?.level}] ${detail.entry?.text ?? ''}`
        : `${detail.type}: ${(detail.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')}`
  console.log(text.slice(0, 300))
}
console.log('--- banner ---')
console.log(String(await evaluate('document.querySelector(".connect-notice")?.innerText ?? "(none)"')))
console.log(String(await evaluate('document.querySelector(".connect-hint")?.innerText ?? "(no hint)"')))
console.log('error line:', String(await evaluate('document.querySelector(".connect-error")?.innerText ?? "(none)"')))
console.log('all /api/ resources:', String(await evaluate(`JSON.stringify(performance.getEntriesByType('resource').filter((e) => e.name.indexOf('/api/ari') > 0).map((e) => e.name.slice(28) + ' -> ' + e.responseStatus + ' @' + Math.round(e.startTime)))`)))

socket.close()
browser.kill('SIGKILL')
process.exit(0)
