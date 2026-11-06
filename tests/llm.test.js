const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTranslateMessages, parseLlmResponse, buildGlossaryMessages, parseGlossary, chatCompletion,
} = require('../src/core/llm.js');

test('buildTranslateMessages includes title, glossary, context and numbered lines', () => {
  const msgs = buildTranslateMessages({
    lines: [{ id: 3, text: 'Hello' }, { id: 4, text: 'Bye\nnow' }],
    before: ['Earlier line'], after: ['Later line'],
    glossary: [{ src: 'Asta', dst: '阿斯塔' }],
    title: 'Black Clover E1', targetLangName: '简体中文',
  });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /简体中文/);
  const user = msgs[1].content;
  for (const s of ['Black Clover E1', 'Asta => 阿斯塔', 'Earlier line', 'Later line', '[3] Hello', '[4] Bye / now']) {
    assert.ok(user.includes(s), `missing ${s}`);
  }
});

test('parseLlmResponse handles fences and surrounding text', () => {
  const m = parseLlmResponse('Sure!\n```json\n{"3":"你好","4":"再见"}\n```', [3, 4]);
  assert.equal(m.get(3), '你好');
  assert.equal(m.get(4), '再见');
});

test('parseLlmResponse throws on missing or empty ids', () => {
  assert.throws(() => parseLlmResponse('{"3":"你好"}', [3, 4]), /4/);
  assert.throws(() => parseLlmResponse('{"3":"","4":"x"}', [3, 4]));
  assert.throws(() => parseLlmResponse('not json', [3]));
});

test('glossary messages and parsing', () => {
  const msgs = buildGlossaryMessages({ allText: 'Asta: hi', title: 'T', targetLangName: '简体中文' });
  assert.ok(msgs[1].content.includes('Asta: hi'));
  assert.deepEqual(parseGlossary('```json\n{"terms":[{"src":"Asta","dst":"阿斯塔"},{"src":"","dst":"x"}]}\n```'), [{ src: 'Asta', dst: '阿斯塔' }]);
  assert.deepEqual(parseGlossary('garbage'), []);
});

test('chatCompletion posts OpenAI-compatible body with extra params', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  const settings = { baseUrl: 'https://api.deepseek.com/', apiKey: 'k', model: 'deepseek-flash', extraParams: '{"thinking":{"type":"disabled"}}' };
  const out = await chatCompletion(settings, [{ role: 'user', content: 'x' }], { fetchImpl, timeoutMs: 1000 });
  assert.equal(out, 'ok');
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.stream, false);
});

test('chatCompletion throws on http error and timeout', async () => {
  const s = { baseUrl: 'https://a', apiKey: 'k', model: 'm', extraParams: '' };
  await assert.rejects(
    chatCompletion(s, [], { fetchImpl: async () => new Response('bad key', { status: 401 }), timeoutMs: 1000 }),
    /401/,
  );
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(chatCompletion(s, [], { fetchImpl: hang, timeoutMs: 20 }), /超时|abort/);
});

test('restoreLineBreaks turns slash markers into real line breaks only for multi-line originals', () => {
  const { restoreLineBreaks } = require('../src/core/llm.js');
  assert.equal(restoreLineBreaks('我们走吧/快点', 'Let us go\nhurry'), '我们走吧\n快点');
  assert.equal(restoreLineBreaks('我们走吧 / 快点', 'Let us go\nhurry'), '我们走吧\n快点');
  assert.equal(restoreLineBreaks('我们走吧／快点', 'Let us go\nhurry'), '我们走吧\n快点');
  assert.equal(restoreLineBreaks('我们走吧，快点', 'Let us go\nhurry'), '我们走吧，快点');
  assert.equal(restoreLineBreaks('AC/DC 的歌', 'An AC/DC song'), 'AC/DC 的歌');
  assert.equal(restoreLineBreaks('一半 / 一半', 'half and half'), '一半 一半');
});

test('parseLlmResponse keeps slash markers for later line-break restore', () => {
  const m = parseLlmResponse('{"4":"再见/现在"}', [4]);
  assert.equal(m.get(4), '再见/现在');
});
