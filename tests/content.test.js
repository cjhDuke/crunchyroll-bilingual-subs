const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

async function harness(storage = {}, ass = {
  parseAss: (text) => ({ events: [{ index: 0, plain: text }] }),
  isDialogueEvent: () => true,
  isTranslatableAssEvent: () => true,
  createPositionedAss: (text) => () => text,
  hashString: (text) => text,
}) {
  const listeners = {}, timers = new Map(), requests = [], sessions = [], writes = [], tracks = [], options = [], events = {}, positioned = [];
  const saved = storage.saved || {};
  let timerId = 0, statusListener;
  class Video {
    paused = false;
    currentTime = 0;
    pauses = 0;
    pause() { this.paused = true; this.pauses++; }
    play() { this.paused = false; return Promise.resolve(); }
  }
  const video = new Video();
  const settings = { enabled: true, targetLang: 'zh' };
  const C = {
    ...require('../src/shared/settings.js'),
    DEFAULT_SETTINGS: settings,
    loadSettings: async () => settings,
    Overlay: class {
      clear() { this.track = null; this.session = null; }
      setOptions(opts) { options.push(opts); } toast() {} hideToast() {}
      setSession(session) { this.session = session; }
      setTrack(track) { this.track = track; tracks.push(track); }
      refreshPositioned() {
        if (this.track) positioned.push(this.track.positionedAss({ displayMode: 'translation' }, (i) => this.session.getLine(i)));
      }
    },
    findVideo: () => video,
    ...ass,
    findLang: () => ({ code: 'zh', name: 'Chinese' }),
    buildGlossaryMessages: (obj) => obj,
    parseGlossary: (obj) => obj,
    TrackSession: class {
      constructor(opts) { this.opts = opts; this.startResult = deferred(); this.lines = new Map(); sessions.push(this); }
      start() { return this.startResult.promise; }
      stop() { this.stopped = true; }
      onUpdate(callback) { this.update = callback; }
      setPlayhead(t) { this.playhead = t; }
      getLine(i) { return this.lines.get(i); }
      stats() { return { total: this.opts.events.length }; }
      isReadyAt(t) { this.readyTime = t; return true; }
    },
  };
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    postMessage() {},
  };
  const context = vm.createContext({
    CRBS: C, window, HTMLVideoElement: Video,
    document: { addEventListener(type, fn) { events[type] = fn; } },
    chrome: {
      runtime: {
        sendMessage: (msg) => {
          const d = deferred(); requests.push({ msg, ...d }); return d.promise;
        },
        onMessage: { addListener: (fn) => { statusListener = fn; } },
      },
      storage: {
        local: {
          get: storage.get || (async (key) => ({ [key]: saved[key] })),
          set: async (obj) => { writes.push(obj); if (storage.set) await storage.set(obj); Object.assign(saved, obj); },
        },
        onChanged: { addListener() {} },
      },
    },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearInterval: (id) => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content/content.js'), 'utf8'), context);
  await flush();
  const send = (data) => listeners.message({ source: window, data: { source: 'crbs-page', ...data } });
  return {
    requests, sessions, writes, video, tracks, options, saved, positioned,
    event: (type) => events[type]({ target: video }),
    offset: (episodeId, offsetSeconds) => new Promise((resolve) => statusListener({ type: 'setSubtitleOffset', episodeId, offsetSeconds }, null, resolve)),
    playback: (episodeId = 'ep87', subtitles = { 'en-US': { format: 'ass', url: 'en.ass' } }, hasAds = false) =>
      send({ type: 'playback', episodeId, info: { subtitles, hasAds }, title: episodeId + ' - Crunchyroll' }),
    select: (lang, episodeId = null) => send({ type: 'subtitle-selected', lang, episodeId }),
    fallback: () => { for (const [id, t] of timers) if (t.ms === 2500) { timers.delete(id); t.fn(); } },
    status: () => { let result; statusListener({ type: 'getStatus' }, null, (r) => { result = r.data; }); return result; },
  };
}

test('leading ad -> main uses fallback without pausing ad; empty responses preserve main', async () => {
  const h = await harness();
  h.playback('ep87', {}, true);
  h.playback();
  h.fallback();
  assert.equal(h.requests.length, 1);
  assert.equal(h.video.pauses, 0);
  h.requests[0].resolve({ ok: true, data: 'ASS' });
  await flush();
  h.sessions[0].startResult.resolve();
  await flush();
  h.playback('promo', {});
  assert.equal(h.status().episodeId, 'ep87');
  assert.equal(h.status().status, 'active');
  assert.equal(h.sessions[0].stopped, undefined);
});

test('ordinary and positioned ASS text share a session, status and cached or incoming translations', async () => {
  const ass = require('../src/core/ass.js');
  const h = await harness({}, ass);
  const text = [
    '[V4+ Styles]', 'Format: Name, Alignment', 'Style: CustomEnglish,2', 'Style: sign_notice,2',
    '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,CustomEnglish,,0,0,0,,First line',
    'Dialogue: 0,0:00:02.00,0:00:03.00,CustomEnglish,,0,0,0,,Second line',
    'Dialogue: 0,0:00:03.00,0:00:04.00,sign_notice,,0,0,0,,{\\pos(200,40)}Notice',
    'Dialogue: 0,0:00:03.00,0:00:04.00,sign_notice,,0,0,0,,{\\move(20,20,100,60)}Moving',
    'Dialogue: 0,0:00:03.00,0:00:04.00,sign_notice,,0,0,0,,{\\p1}m 0 0 l 10 10',
  ].join('\n');
  h.playback();
  h.select('en-US');
  h.requests[0].resolve({ ok: true, data: text });
  await flush();
  const session = h.sessions[0];
  session.lines.set(2, { t: '告示' });
  session.startResult.resolve();
  await flush();
  assert.deepEqual(session.opts.events.map((event) => event.plain), ['First line', 'Second line', 'Notice', 'Moving']);
  assert.equal(h.status().stats.total, 4);
  assert.deepEqual(h.tracks[0].dialogue.map((event) => event.plain), ['First line', 'Second line']);
  assert.deepEqual(ass.parseAss(h.positioned.at(-1)).events.map((event) => event.plain), ['告示']);
  session.lines.set(3, { t: '移动中' });
  session.update();
  const displayed = ass.parseAss(h.positioned.at(-1)).events;
  assert.deepEqual(displayed.map((event) => event.plain), ['告示', '移动中']);
  assert.match(displayed[1].text, /\\move\(20,20,100,60\)/);
  const updateCount = h.positioned.length;
  h.playback('next');
  session.update();
  assert.equal(h.positioned.length, updateCount);
});

test('selection before playback, fallback preference, and explicit none', async () => {
  const h = await harness();
  h.select('de-DE');
  const subs = { 'de-DE': { format: 'ass', url: 'de.ass' }, 'en-US': { format: 'ass', url: 'en.ass' } };
  h.playback('ep87', subs);
  assert.equal(h.requests[0].msg.url, 'de.ass');
  h.select('none');
  h.playback('ep87', subs);
  h.fallback();
  assert.equal(h.status().lang, 'none');
  assert.equal(h.requests.length, 1);
  const second = await harness();
  second.playback('ep87', subs);
  second.fallback();
  assert.equal(second.requests[0].msg.url, 'en.ass');
  const third = await harness();
  third.playback('ep87', { 'de-DE': subs['de-DE'] });
  third.fallback();
  assert.equal(third.requests[0].msg.url, 'de.ass');
});

test('independent ad IDs do not disable the main episode gate; same-episode ads release it', async () => {
  const h = await harness();
  h.playback('ad-id', {}, true);
  h.playback('ep87'); h.select('en-US');
  assert.equal(h.video.pauses, 1);
  assert.equal(h.video.paused, true);
  h.playback('ep87', {}, true);
  assert.equal(h.video.paused, false);
  assert.equal(h.status().episodeId, 'ep87');
  assert.equal(h.requests.length, 1);
});

test('signed URL refresh is idempotent while loading/active and retries after an error', async () => {
  const h = await harness();
  h.playback(); h.select('en-US');
  const refreshed = { 'en-US': { format: 'ass', url: 'en.ass?sig=new' } };
  h.playback('ep87', refreshed);
  assert.equal(h.requests.length, 1);
  h.requests[0].reject(new Error('expired'));
  await flush();
  assert.equal(h.status().status, 'error');
  assert.equal(h.video.paused, false);
  h.playback('ep87', refreshed);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].msg.url, 'en.ass?sig=new');
  h.requests[1].resolve({ ok: true, data: 'new' });
  await flush();
  h.sessions[0].startResult.resolve();
  await flush();
  h.playback('ep87', refreshed);
  assert.equal(h.requests.length, 2);
  assert.equal(h.status().status, 'active');
});

test('episode change replaces a pending fallback; selected track arriving later self-heals', async () => {
  const h = await harness();
  h.playback('ep87');
  h.playback('ep88');
  h.fallback();
  assert.equal(h.requests.length, 1);
  assert.equal(h.status().episodeId, 'ep88');
  h.select('de-DE');
  assert.equal(h.status().status, 'idle');
  h.playback('ep88', { 'de-DE': { format: 'ass', url: 'de.ass' } });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].msg.url, 'de.ass');
});

test('ABA track changes ignore stale downloads and stale session starts', async () => {
  const h = await harness();
  h.playback(); h.select('en-US');
  h.select('none'); h.select('en-US');
  h.requests[0].resolve({ ok: true, data: 'stale' });
  await flush();
  assert.equal(h.sessions.length, 0);
  h.requests[1].resolve({ ok: true, data: 'current' });
  await flush();
  assert.equal(h.sessions.length, 1);
  h.playback('ep88'); h.select('en-US');
  h.sessions[0].startResult.resolve();
  await flush();
  assert.equal(h.status().status, 'loading');
  assert.equal(h.sessions[0].stopped, true);
  await h.sessions[0].opts.deps.cacheSet({ lines: {} });
  assert.equal(Object.values(h.writes[0])[0].episodeId, 'ep87');
  const glossary = h.sessions[0].opts.deps.glossary('text');
  assert.equal(h.requests[3].msg.messages.title, 'ep87');
  h.requests[3].resolve({ ok: true, data: [] });
  await glossary;
});

test('offset applies positive/negative time to sessions, seeking, timeupdate and gate without restarting translation', async () => {
  const h = await harness();
  h.video.currentTime = 10;
  h.playback(); h.select('en-US');
  await h.offset('ep87', 12);
  h.requests[0].resolve({ ok: true, data: 'ASS' });
  await flush();
  const session = h.sessions[0];
  assert.equal(session.playhead, -2);
  await h.offset('ep87', -2.5);
  assert.equal(session.playhead, 12.5);
  assert.equal(session.readyTime, 12.5);
  h.video.currentTime = 20; h.event('seeking');
  assert.equal(session.playhead, 22.5);
  h.video.currentTime = 21; h.event('timeupdate');
  assert.equal(session.playhead, 23.5);
  await h.offset('ep87', 0);
  assert.equal(session.playhead, 21);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(session.stopped, undefined);
  assert.equal(h.options.at(-1).subtitleOffsetSeconds, 0);
});

test('offset persists per episode, survives none/language/signature changes and restores on reload', async () => {
  const saved = {};
  const h = await harness({ saved });
  assert.equal((await h.offset('ep87', 1)).ok, false);
  h.playback(); await flush();
  await h.offset('ep87', 30);
  h.select('none'); h.playback(); await flush();
  assert.equal(h.status().subtitleOffsetSeconds, 30);
  assert.equal(h.status().lang, 'none');
  h.select('en-US');
  assert.equal(h.status().subtitleOffsetSeconds, 30);
  h.playback('ep88'); await flush();
  assert.equal(h.status().subtitleOffsetSeconds, 0);
  assert.equal((await h.offset('ep87', 9)).ok, false);
  await h.offset('ep88', -4);
  assert.equal(saved['subtitleOffset:ep87'], 30);
  assert.equal(saved['subtitleOffset:ep88'], -4);
  assert.equal(saved.settings, undefined);
  h.playback('ep87'); await flush();
  assert.equal(h.status().subtitleOffsetSeconds, 30);
  const reload = await harness({ saved });
  reload.playback(); await flush();
  assert.equal(reload.status().subtitleOffsetSeconds, 30);
});

test('late offset reads cannot overwrite a new episode or a manual change (including ABA)', async () => {
  const reads = [];
  const h = await harness({ get: (key) => { const d = deferred(); reads.push({ key, ...d }); return d.promise; } });
  h.playback('A'); await flush();
  h.playback('B'); await flush();
  reads[1].resolve({ 'subtitleOffset:B': -5 }); await flush();
  reads[0].resolve({ 'subtitleOffset:A': 100 }); await flush();
  assert.equal(h.status().subtitleOffsetSeconds, -5);
  h.playback('A'); await flush();
  await h.offset('A', 7);
  reads[2].resolve({ 'subtitleOffset:A': 100 }); await flush();
  assert.equal(h.status().subtitleOffsetSeconds, 7);
});

test('offset writes are serialized and returning to an episode waits for pending persistence', async () => {
  const first = deferred();
  let count = 0;
  const h = await harness({ set: () => ++count === 1 ? first.promise : Promise.resolve() });
  h.playback('A'); await flush();
  const one = h.offset('A', 2);
  const two = h.offset('A', 3);
  await flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.status().subtitleOffsetSeconds, 3);
  h.playback('B'); h.playback('A');
  first.resolve(); await one; await two; await flush();
  assert.equal(h.saved['subtitleOffset:A'], 3);
  assert.equal(h.status().subtitleOffsetSeconds, 3);
  assert.equal((await h.offset('A', NaN)).ok, false);
});
