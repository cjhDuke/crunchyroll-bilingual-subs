const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const settings = require('../src/shared/settings.js');

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function harness(url = 'https://www.crunchyroll.com/watch/A') {
  const elements = {}, requests = [], intervals = [];
  const $ = (id) => elements[id] || (elements[id] = {
    value: '', disabled: id === 'offsetControls', style: {}, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
  });
  const context = vm.createContext({
    CRBS: { ...settings, loadSettings: async () => settings.DEFAULT_SETTINGS, saveSettings: async () => {} },
    document: { getElementById: $ },
    chrome: {
      runtime: { openOptionsPage() {} },
      tabs: {
        query: async () => [{ id: 1, url }],
        sendMessage: (id, msg) => { const d = deferred(); requests.push({ msg, ...d }); return d.promise; },
      },
    },
    setInterval: (fn) => intervals.push(fn), confirm: () => true,
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/popup/popup.js'), 'utf8'), context);
  await flush();
  return {
    $, requests, refresh: () => intervals[0](),
    emit: (id, type, value) => { if (value !== undefined) $(id).value = value; return $(id).listeners[type](); },
    status: async (index, episodeId = 'A', offset = 0) => {
      requests[index].resolve({ ok: true, data: { episodeId, subtitleOffsetSeconds: offset, status: 'active', enabled: true } });
      await flush();
    },
  };
}

test('offset controls disable outside Crunchyroll and without an episode', async () => {
  const outside = await harness('https://example.com');
  assert.equal(outside.$('offsetControls').disabled, true);
  assert.equal(outside.requests.length, 0);
  const h = await harness();
  await h.status(0, null);
  assert.equal(h.$('offsetControls').disabled, true);
  await h.emit('offsetLater', 'click');
  assert.equal(h.requests.length, 1);
});

test('late status response for old episode cannot overwrite new episode controls', async () => {
  const h = await harness();
  const newer = h.refresh();
  await h.status(1, 'B', 8);
  await newer;
  await h.status(0, 'A', 2);
  assert.equal(h.$('offsetSeconds').value, 8);
  h.emit('offsetLater', 'click');
  assert.equal(h.requests[2].msg.episodeId, 'B');
  assert.equal(h.requests[2].msg.offsetSeconds, 8.5);
});

test('polling preserves edits and dragging; queued changes save latest action with no retranslation', async () => {
  const h = await harness();
  await h.status(0);
  h.emit('offsetSeconds', 'focus'); h.emit('offsetSeconds', 'input', '-12.5');
  h.refresh(); await h.status(1, 'A', 0);
  assert.equal(h.$('offsetSeconds').value, '-12.5');
  h.emit('offsetSeconds', 'change');
  assert.equal(h.requests[2].msg.offsetSeconds, -12.5);
  h.emit('offsetSlider', 'pointerdown'); h.emit('offsetSlider', 'input', '30');
  h.emit('offsetLater', 'click');
  h.refresh(); await h.status(3, 'A', 0);
  assert.equal(h.$('offsetSeconds').value, 30.5);
  assert.equal(h.requests.filter((r) => r.msg.type === 'setSubtitleOffset').length, 1);
  h.requests[2].resolve({ ok: true }); await flush();
  assert.equal(h.requests[4].msg.offsetSeconds, 30.5);
  h.requests[4].resolve({ ok: true }); await flush();
  h.emit('offsetReset', 'click');
  assert.equal(h.requests[5].msg.offsetSeconds, 0);
  h.requests[5].resolve({ ok: true }); await flush();
  assert.equal(h.$('offsetFeedback').textContent, '已保存到本集');
  assert.ok(h.requests.every((r) => r.msg.type !== 'retranslate'));
});

test('episode switch discards queued old-episode actions while a save is pending', async () => {
  const h = await harness(); await h.status(0);
  h.emit('offsetLater', 'click'); h.emit('offsetLater', 'click');
  h.refresh(); await h.status(2, 'B', -3);
  h.requests[1].resolve({ ok: false, error: 'stale' }); await flush();
  assert.equal(h.requests.length, 3);
  assert.equal(h.$('offsetSeconds').value, -3);
  assert.equal(h.$('offsetFeedback').textContent, '');
  h.emit('offsetEarlier', 'click');
  assert.equal(h.requests[3].msg.episodeId, 'B');
  assert.equal(h.requests[3].msg.offsetSeconds, -3.5);
});
