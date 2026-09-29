// js/tests/run.js — imports every suite and runs them (loaded by tests.html).
// Core suites are imported statically; each phase-2 panel has its own file in tests/panels/<id>.test.js
// (loaded dynamically, so one broken panel test file can't stop the others — it shows up as a failure).
import { run, suite, test } from './harness.js';
import './store.test.js';
import './io.test.js';
import './adjust.test.js';
import './render.test.js';
import './exporter.test.js';
import './brush.test.js';
import './core.test.js';
import './cutout-quality.test.js';
import './core-save.test.js';
import './export-dialog.test.js';

const PANEL_TESTS = ['idphoto', 'adjust', 'beauty', 'crop', 'text', 'sticker', 'erase', 'mosaic', 'batch'];

window.__testResult = (async () => {
  const res = await Promise.allSettled(PANEL_TESTS.map((id) => import(`./panels/${id}.test.js`)));
  res.forEach((r, i) => {
    if (r.status === 'rejected') {
      suite(`面板测试文件 ${PANEL_TESTS[i]}`);
      test('加载测试文件', () => { throw r.reason; });
    }
  });
  return run(document.body);
})().catch((err) => {
  const s = document.getElementById('summary');
  s.dataset.done = '1';
  s.dataset.fail = '1';
  s.className = 'bad';
  s.textContent = `测试运行出错：${err.message}`;
  console.error(err);
});
