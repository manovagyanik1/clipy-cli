import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../dist/chromeForClipy.js', import.meta.url), 'utf8');
const expression = source.match(/await target\.evaluate\(\s*(`[^`]+`)/)?.[1];
assert.ok(expression, 'capture title script is present');
const marker = 'clipy-rec session target';
const script = vm.runInNewContext(expression, { marker });
const queue = [];
let observer;
let title = 'Original';
const context = vm.createContext({
  document: {
    get title() { return title; },
    set title(value) { title = value; if (observer) queue.push(observer); },
    querySelector() { return {}; },
  },
  MutationObserver: class {
    constructor(fn) { this.fn = fn; }
    observe() { observer = this.fn; }
    disconnect() { observer = undefined; }
  },
  queue,
});
vm.runInContext(script, context);
assert.equal(title, marker);
vm.runInContext('document.title = "SPA route"', context);
assert.doesNotThrow(() => vm.runInContext('while (queue.length) queue.shift()()', context, { timeout: 100 }),
  'pinning a changed title must not recurse indefinitely');
assert.equal(title, marker);
vm.runInContext('globalThis.__clipyRestoreCaptureTitle()', context);
vm.runInContext('document.title = "After capture"; while (queue.length) queue.shift()()', context);
assert.equal(title, 'After capture');
console.log('PASS: SPA title pinning settles and releases after selection');
