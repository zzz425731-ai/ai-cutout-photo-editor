// Minimal Chrome DevTools Protocol driver (Node 24, no npm packages).
//
//   import { launch } from './cdp.mjs';
//   const b = await launch({ url: 'http://127.0.0.1:7861/', width: 1600, height: 1000 });
//   await b.waitFor('document.querySelector(".rail")');
//   await b.eval('1+1');                       // evaluate JS in the page (awaits promises)
//   await b.click(400, 300);                    // mouse click at CSS px
//   await b.drag([[100,100],[200,150],[300,200]]); // press, move through points, release
//   await b.key('z', { ctrl: true });           // keyboard shortcut
//   await b.upload('input[type=file]', ['C:\\path\\a.jpg']); // set files on an <input type=file>
//   await b.screenshot('C:\\...\\shot.png');
//   console.log(b.errors);                      // console errors + uncaught exceptions
//   await b.close();
//
// Or from the command line (one-shot screenshot + error dump):
//   node tests/cdp.mjs http://127.0.0.1:7861/ out.png
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ url = 'about:blank', width = 1600, height = 1000, headless = true, port } = {}) {
  port ??= 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'kt-chrome-'));
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--no-proxy-server',
    // Use the NVIDIA GPU (own 8 GB VRAM): by default Chrome picks the AMD iGPU, whose "VRAM" is the
    // user's system RAM — big test images then eat several GB of RAM and slow the whole PC down.
    '--use-angle=d3d11', '--force_high_performance_gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', 'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  const proc = spawn(CHROME, args, { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break; } catch {}
    await sleep(100);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  const errors = [];
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        logs.push(`[${msg.params.type}] ${text}`);
        if (msg.params.type === 'error') errors.push(text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(`${d.exception?.description ?? d.text} @${d.url ?? ''}:${d.lineNumber}`);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text + ' ' + (msg.params.entry.url ?? ''));
      listeners.forEach((l) => l(msg));
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const b = {
    send, errors, logs, port,
    async goto(u) {
      const loaded = new Promise((r) => { const f = (m) => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(f), 1); r(); } }; listeners.push(f); });
      await send('Page.navigate', { url: u }); await loaded; await sleep(300);
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      return r.result.value;
    },
    async waitFor(expr, timeout = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { try { if (await b.eval(`!!(${expr})`)) return true; } catch {} await sleep(150); }
      throw new Error('waitFor timeout: ' + expr);
    },
    async mouse(type, x, y, opts = {}) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: opts.button ?? 'left', buttons: type === 'mouseReleased' ? 0 : (opts.buttons ?? 1), clickCount: opts.clickCount ?? 1, modifiers: opts.modifiers ?? 0 });
    },
    async click(x, y, opts = {}) { await b.mouse('mouseMoved', x, y, { buttons: 0 }); await b.mouse('mousePressed', x, y, opts); await b.mouse('mouseReleased', x, y, opts); await sleep(50); },
    async clickSelector(sel) {
      const r = await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()`);
      if (!r) throw new Error('clickSelector: not found ' + sel);
      await b.click(r[0], r[1]);
    },
    async drag(points, opts = {}) {
      const [x0, y0] = points[0];
      await b.mouse('mouseMoved', x0, y0, { buttons: 0 }); await b.mouse('mousePressed', x0, y0, opts);
      for (const [x, y] of points.slice(1)) { await b.mouse('mouseMoved', x, y, opts); await sleep(16); }
      const [xn, yn] = points[points.length - 1]; await b.mouse('mouseReleased', xn, yn, opts); await sleep(50);
    },
    async wheel(x, y, deltaY, modifiers = 0) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers }); await sleep(50); },
    async key(key, { ctrl = false, shift = false, alt = false, type } = {}) {
      const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
      const code = key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /[0-9]/.test(key) ? 'Digit' + key : '') : key;
      const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Delete: 46, Backspace: 8, Enter: 13, Escape: 27, ' ': 32 }[key] ?? 0);
      const text = key.length === 1 && !ctrl && !alt ? key : undefined;
      if (type !== 'up') await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers, text });
      if (type !== 'down') await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
      await sleep(50);
    },
    async type(text) { await send('Input.insertText', { text }); await sleep(50); },
    async upload(selector, files) {
      const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('upload: selector not found ' + selector);
      await send('DOM.setFileInputFiles', { nodeId, files });
    },
    async screenshot(path, clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      return path;
    },
    async close() {
      // Browser.close sometimes never answers — don't wait on it.
      try { await Promise.race([send('Browser.close'), sleep(1500)]); } catch {}
      try { ws.close(); } catch {}
      for (const [, p] of pending) p.rej(new Error('closed')); pending.clear();
      try { proc.kill(); } catch {}
      await sleep(300);
      if (proc.exitCode === null) spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
  if (url !== 'about:blank') await b.goto(url);
  return b;
}

// CLI: node tests/cdp.mjs <url> <out.png>
if (process.argv[1] && process.argv[1].endsWith('cdp.mjs') && process.argv[2]) {
  const b = await launch({ url: process.argv[2] });
  await sleep(1500);
  await b.screenshot(process.argv[3] ?? 'shot.png');
  console.log(JSON.stringify({ errors: b.errors, logs: b.logs.slice(-30) }, null, 2));
  await b.close();
  process.exit(0);
}
