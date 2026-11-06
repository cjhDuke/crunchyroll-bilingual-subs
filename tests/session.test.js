const test = require('node:test');
const assert = require('node:assert/strict');
const { TrackSession } = require('../src/core/session.js');

// 10 dialogue lines, 10 s apart; batchSize 2 => 5 batches
function makeEvents() {
  return Array.from({ length: 10 }, (_, i) => ({
    index: i, start: i * 10, end: i * 10 + 5, style: 'main', name: '', text: `line ${i}`, plain: `line ${i}`,
  }));
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function harness({ cache = null, concurrency = 1 } = {}) {
  const calls = [];
  const glossaryD = deferred();
  let saved = null;
  const session = new TrackSession({
    events: makeEvents(),
    title: 'T',
    settings: { batchSize: 2, concurrency },
    cacheDelayMs: 0,
    deps: {
      translateBatch: (input, ctx) => {
        const d = deferred();
        calls.push({ ids: input.lines.map((l) => l.id), glossary: ctx.glossary, d, input });
        return d.promise;
      },
      glossary: () => glossaryD.promise,
      cacheGet: async () => cache,
      cacheSet: async (obj) => { saved = obj; },
    },
  });
  return { session, calls, glossaryD, getSaved: () => saved };
}
const ok = (ids, source = 'llm') => ({ map: new Map(ids.map((id) => [id, 'T' + id])), source });

test('first batch does not wait for the glossary; later ones carry it', async () => {
  const h = harness({ concurrency: 3 });
  await h.session.start();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].ids, [0, 1]);
  assert.deepEqual(h.calls[0].glossary, []);
  h.glossaryD.resolve([{ src: 'A', dst: 'B' }]);
  await tick();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[1].glossary, [{ src: 'A', dst: 'B' }]);
  assert.deepEqual(h.calls[1].ids, [2, 3]);
});

test('batch input includes surrounding context lines', async () => {
  const h = harness({ concurrency: 5 });
  await h.session.start();
  h.glossaryD.resolve([]);
  await tick();
  const second = h.calls.find((c) => c.ids[0] === 2);
  assert.deepEqual(second.input.before, ['line 0', 'line 1']);
  assert.deepEqual(second.input.after, ['line 4', 'line 5', 'line 6']);
});

test('isReadyAt and getLine follow batch completion', async () => {
  const h = harness();
  await h.session.start();
  await tick();
  assert.equal(h.session.isReadyAt(0), false);
  h.calls[0].d.resolve(ok([0, 1]));
  await tick();
  assert.equal(h.session.isReadyAt(0), true);
  assert.deepEqual(h.session.getLine(1), { t: 'T1', s: 'llm' });
  assert.equal(h.session.isReadyAt(95), false);
});

test('setPlayhead moves the target batch to the front', async () => {
  const h = harness();
  await h.session.start();
  h.glossaryD.resolve([]);
  await tick();
  h.session.setPlayhead(72); // inside batch with lines 6,7 (start 60..75)
  h.calls[0].d.resolve(ok([0, 1]));
  await tick();
  assert.deepEqual(h.calls[1].ids, [6, 7]);
  h.calls[1].d.resolve(ok([6, 7]));
  await tick();
  assert.deepEqual(h.calls[2].ids, [8, 9]);
});

test('full cache hit makes no translate calls', async () => {
  const lines = {};
  for (let i = 0; i < 10; i++) lines[i] = { t: 'C' + i, s: 'llm' };
  const h = harness({ cache: { lines, glossary: [] } });
  await h.session.start();
  await tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.session.isReadyAt(0), true);
  assert.equal(h.session.stats().done, 10);
});

test('failed batches count as ready (original shown) and are reported', async () => {
  const h = harness();
  await h.session.start();
  await tick();
  h.calls[0].d.reject(new Error('both failed'));
  await tick();
  assert.equal(h.session.isReadyAt(0), true);
  assert.equal(h.session.stats().failedBatches, 1);
});

test('results are cached with source marks', async () => {
  const h = harness();
  await h.session.start();
  await tick();
  h.calls[0].d.resolve(ok([0, 1], 'google'));
  await tick(); await tick();
  assert.deepEqual(h.getSaved().lines['0'], { t: 'T0', s: 'google' });
  assert.equal(h.session.stats().google, 2);
});

test('retranslate("google") only redoes google batches and keeps old text meanwhile', async () => {
  const lines = {};
  for (let i = 0; i < 10; i++) lines[i] = { t: 'C' + i, s: i === 4 ? 'google' : 'llm' };
  const h = harness({ cache: { lines, glossary: [] } });
  await h.session.start();
  h.session.retranslate('google');
  await tick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].ids, [4, 5]);
  assert.deepEqual(h.session.getLine(4), { t: 'C4', s: 'google' });
  h.calls[0].d.resolve(ok([4, 5]));
  await tick();
  assert.deepEqual(h.session.getLine(4), { t: 'T4', s: 'llm' });
});

test('stop prevents further requests and ignores late results', async () => {
  const h = harness({ concurrency: 1 });
  await h.session.start();
  h.glossaryD.resolve([]);
  await tick();
  h.session.stop();
  h.calls[0].d.resolve(ok([0, 1]));
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.session.getLine(0), undefined);
});
