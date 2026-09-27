/**
 * Screenshot the running dashboard at real scroll positions.
 *
 * Headless `--screenshot` only ever captures the top of the page, and a tall window is not the
 * same as a scrolled one: the pinned sections are sized in `dvh`, so stretching the viewport
 * stretches the pin instead of moving through it. This drives the browser over CDP, scrolls to a
 * fraction of the document, waits for the animation frames to settle, and captures.
 *
 *   node scripts/shoot.mjs <path> <name> [fractions...]
 *   node scripts/shoot.mjs / landing 0 0.25 0.5
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [pathArg = '/', nameArg = 'page', ...fractionArgs] = process.argv.slice(2);
const fractions = fractionArgs.length > 0 ? fractionArgs.map(Number) : [0];
const port = 9333;
const outDir = '/tmp/shots2';

const profile = mkdtempSync(join(tmpdir(), 'ari-cdp-'));
const browser = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(pathname) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (res.ok) return await res.json();
    } catch {
      // the browser is still starting
    }
    await wait(250);
  }
  throw new Error('chromium did not come up');
}

const targets = await json('/json/list');
const page = targets.find((t) => t.type === 'page');
if (page === undefined) {
  browser.kill();
  throw new Error('no page target');
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  const settle = pending.get(message.id);
  if (settle !== undefined) {
    pending.delete(message.id);
    settle.resolve(message.result ?? {});
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = (nextId += 1);
    pending.set(id, { resolve });
    socket.send(JSON.stringify({ id, method, params }));
  });

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:5173${pathArg}` });
await wait(3500);

const { result: metrics } = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({ h: document.documentElement.scrollHeight, vh: window.innerHeight })',
  returnByValue: true,
});
const { h, vh } = JSON.parse(metrics.value);
console.log(`document ${h}px tall, viewport ${vh}px`);

for (const fraction of fractions) {
  await send('Runtime.evaluate', { expression: `window.scrollTo({ top: Math.round(${fraction} * (document.documentElement.scrollHeight - window.innerHeight)), behavior: 'instant' })` });
  await wait(1400);
  const shot = `${outDir}/${nameArg}@${Math.round(fraction * 100)}.png`;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(shot, Buffer.from(data, 'base64'));
  console.log(shot);
}

socket.close();
browser.kill();
process.exit(0);
