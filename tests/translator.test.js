const test = require('node:test');
const assert = require('node:assert/strict');
const { googleTranslateLines } = require('../src/core/google.js');
const { translateBatch, LANGS } = require('../src/core/translator.js');

function gResponse(text) {
  return new Response(JSON.stringify([[[text, 'src', null, null]]]), { status: 200 });
}

test('googleTranslateLines joins lines and splits the result', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    assert.ok(url.includes('tl=zh-CN'));
    return gResponse('一\n二');
  };
  assert.deepEqual(await googleTranslateLines(['one', 'two\nlines'], 'zh-CN', { fetchImpl }), ['一', '二']);
  assert.equal(calls, 1);
});

test('googleTranslateLines falls back to per-line on count mismatch', async () => {
  const fetchImpl = async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    if (q.includes('\n')) return gResponse('合并成一行');
    return gResponse('译:' + q);
  };
  assert.deepEqual(await googleTranslateLines(['a', 'b'], 'zh-CN', { fetchImpl }), ['译:a', '译:b']);
});

const batch = { lines: [{ id: 1, text: 'Hi' }, { id: 2, text: 'Bye' }], before: [], after: [] };
const ctx = { glossary: [], title: 'T', lang: LANGS.find((l) => l.code === 'zh-CN') };

test('translateBatch retries the LLM once before succeeding', async () => {
  let n = 0;
  const deps = {
    llm: async () => { n++; if (n === 1) throw new Error('boom'); return '{"1":"嗨","2":"拜"}'; },
    google: async () => { throw new Error('should not be called'); },
  };
  const r = await translateBatch(batch, ctx, deps);
  assert.equal(r.source, 'llm');
  assert.equal(r.map.get(2), '拜');
  assert.equal(n, 2);
});

test('translateBatch falls back to google after two LLM failures', async () => {
  const deps = {
    llm: async () => '{"1":"only one"}',
    google: async (texts, tl) => { assert.equal(tl, 'zh-CN'); return texts.map((t) => 'G' + t); },
  };
  const r = await translateBatch(batch, ctx, deps);
  assert.equal(r.source, 'google');
  assert.equal(r.map.get(1), 'GHi');
});

test('translateBatch throws when both fail', async () => {
  const deps = { llm: async () => { throw new Error('x'); }, google: async () => { throw new Error('y'); } };
  await assert.rejects(translateBatch(batch, ctx, deps));
});
