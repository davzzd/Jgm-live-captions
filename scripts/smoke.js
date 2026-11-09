/**
 * Quick check that the app starts and its pages load without errors.
 * Run with `npm run smoke`. GitHub runs it before every deploy.
 *
 * Copies the files the Dockerfile copies into a temporary folder and runs the server there,
 * so a file missing from the Docker image fails here too, and the real logs aren't touched.
 * Needs Chrome; set CHROME_PATH if it isn't found.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const DEBUG_PORT = PORT + 1000;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures.push(name);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

// The app files, as listed in the Dockerfile's COPY lines
function copyAppFiles(dir) {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const files = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+\.\/\s*$/gm)]
    .map((m) => m[1])
    .filter((f) => !f.includes('*'));
  files.forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)));
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url);
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`nothing answered at ${url}`);
}

// Minimal Chrome DevTools connection: send commands, collect page errors
async function openBrowser(chromePath, profileDir) {
  const args = ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${profileDir}`, 'about:blank'];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const chrome = spawn(chromePath, args, { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('Chrome did not start');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push((d.exception && d.exception.description || d.text || '').split('\n')[0]);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    errors,
    evaluate,
    async open(url) {
      errors.length = 0;
      await send('Page.navigate', { url });
      await sleep(2000);
    },
    close() {
      ws.close();
      chrome.kill();
    }
  };
}

function setStatus(status) {
  return fetch(`${BASE}/api/audience-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, message: 'smoke test' })
  });
}

const audienceState = `({
  header: document.getElementById('statusText').textContent,
  spinner: getComputedStyle(document.getElementById('loadingState')).display !== 'none',
  title: document.getElementById('serviceStatusTitle').textContent
})`;

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH');

  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captions-smoke-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captions-smoke-chrome-'));
  copyAppFiles(appDir);

  const server = spawn(process.execPath, ['ws-server.js'], {
    cwd: appDir,
    env: { ...process.env, PORT: String(PORT), NODE_PATH: path.join(ROOT, 'node_modules') },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverErrors = '';
  server.stderr.on('data', (d) => { serverErrors += d; });

  let browser;
  try {
    await waitFor(`${BASE}/audience`).catch((e) => {
      throw new Error(`${e.message}\n${serverErrors}`);
    });

    // Every page answers
    const pages = {};
    for (const p of ['/', '/audience', '/client', '/transcript', '/Logo.png']) {
      const res = await fetch(BASE + p);
      pages[p] = await res.text();
      check(`GET ${p}`, res.status === 200, `status ${res.status}`);
    }
    check('/ and /audience are the same page', pages['/'] === pages['/audience']);

    browser = await openBrowser(chromePath, profileDir);

    // Phone page, at both addresses
    for (const p of ['/', '/audience']) {
      await setStatus('offline');
      await browser.open(BASE + p);
      let s = await browser.evaluate(audienceState);
      check(`${p} loads with no page errors`, browser.errors.length === 0, browser.errors.join('; '));
      check(`${p} shows "not started", not the spinner`, !s.spinner && s.header === 'Waiting', JSON.stringify(s));

      await setStatus('live');
      await sleep(500);
      s = await browser.evaluate(audienceState);
      check(`${p} goes Live`, s.header === 'Live', JSON.stringify(s));

      await setStatus('ended');
      await sleep(500);
      s = await browser.evaluate(audienceState);
      check(`${p} shows the end message`, s.header === 'Ended' && s.title === 'Thank you for joining us', JSON.stringify(s));
    }

    // Admin pages
    for (const p of ['/client', '/transcript']) {
      await browser.open(BASE + p);
      check(`${p} loads with no page errors`, browser.errors.length === 0, browser.errors.join('; '));
    }
  } finally {
    if (browser) browser.close();
    server.kill();
  }

  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
