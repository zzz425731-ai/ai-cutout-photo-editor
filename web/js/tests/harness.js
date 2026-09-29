// js/tests/harness.js — tiny dependency-free test runner. Results are written into the DOM:
//   #summary[data-done="1"][data-pass=N][data-fail=M]   and one <li class="pass|fail"> per test.
// Headless: chrome --headless=new --dump-dom --virtual-time-budget=30000 http://127.0.0.1:PORT/tests.html

const tests = [];
let currentSuite = '';

export function suite(name) { currentSuite = name; }
export function test(name, fn) { tests.push({ suite: currentSuite, name, fn }); }

export class AssertionError extends Error {}
export function assert(cond, msg = '断言失败') { if (!cond) throw new AssertionError(msg); }
export function assertEq(a, b, msg = '') {
  if (a !== b) throw new AssertionError(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
export function assertClose(a, b, tol, msg = '') {
  if (!(Math.abs(a - b) <= tol)) throw new AssertionError(`${msg} 期望 ${b}±${tol}，实际 ${a}`);
}
export function assertThrows(fn, re, msg = '') {
  let threw = false;
  try { fn(); } catch (e) { threw = true; if (re && !re.test(e.message)) throw new AssertionError(`${msg} 错误信息不符：${e.message}`); }
  if (!threw) throw new AssertionError(`${msg} 期望抛出错误`);
}
export async function assertRejects(p, re, msg = '') {
  let threw = false;
  try { await p; } catch (e) { threw = true; if (re && !re.test(e.message)) throw new AssertionError(`${msg} 错误信息不符：${e.message}`); }
  if (!threw) throw new AssertionError(`${msg} 期望失败`);
}

export async function run(root) {
  const summary = root.querySelector('#summary');
  const list = root.querySelector('#results');
  let pass = 0, fail = 0;
  const t0 = performance.now();
  let lastSuite = null;
  for (const t of tests) {
    if (t.suite !== lastSuite) {
      lastSuite = t.suite;
      const hd = document.createElement('li');
      hd.className = 'suite';
      hd.textContent = t.suite;
      list.append(hd);
    }
    const li = document.createElement('li');
    const s0 = performance.now();
    try {
      await t.fn();
      pass++;
      li.className = 'pass';
      li.textContent = `✓ ${t.name}`;
    } catch (err) {
      fail++;
      li.className = 'fail';
      li.textContent = `✗ ${t.name} — ${err.message}`;
      console.error(`[test] ${t.suite} / ${t.name}:`, err);
    }
    const ms = document.createElement('span');
    ms.className = 'ms';
    ms.textContent = `${Math.round(performance.now() - s0)} ms`;
    li.append(ms);
    li.dataset.name = `${t.suite} / ${t.name}`;
    list.append(li);
  }
  summary.dataset.done = '1';
  summary.dataset.pass = String(pass);
  summary.dataset.fail = String(fail);
  summary.className = fail ? 'bad' : 'good';
  summary.textContent = `${fail ? '有失败' : '全部通过'}：通过 ${pass}，失败 ${fail}，共 ${pass + fail} 项，用时 ${Math.round(performance.now() - t0)} ms`;
  document.title = `${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail}`;
  return { pass, fail };
}

// ---------------------------------------------------------------- helpers
export function canvasOf(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  draw?.(ctx, w, h);
  return c;
}
export function px(c, x, y) {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}
export function pixels(c) { return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; }
export function stats(c, fn = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b) {
  const d = pixels(c);
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { const v = fn(d[i], d[i + 1], d[i + 2], d[i + 3], i / 4); sum += v; sum2 += v * v; n++; }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
}
export async function blobToCanvasT(blob) {
  const bmp = await createImageBitmap(blob);
  const c = canvasOf(bmp.width, bmp.height, (ctx) => ctx.drawImage(bmp, 0, 0));
  return c;
}
