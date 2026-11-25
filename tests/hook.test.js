const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/core/playback.js');
const playUrl = (id) => `https://www.crunchyroll.com/playback/v4/${id}/web/chrome/play`;
const legacy = () => ({ url: 'https://cdn/clean.mpd', hardSubs: { 'en-US': { url: 'old' } }, subtitles: { 'en-US': { format: 'ass', url: 'https://cdn/sub.ass?sig=x' } } });

function harness() {
  const messages = [], pending = [];
  class XHR {
    listeners = new Set();
    responseType = '';
    get responseText() { return this.body; }
    get response() { return this.responseType === 'json' ? JSON.parse(this.body) : this.body; }
    addEventListener(type, fn) { this.listeners.add(fn); }
    removeEventListener(type, fn) { this.listeners.delete(fn); }
    open(method, url) { this.url = url; this.readyState = 1; }
    complete(body) {
      this.body = JSON.stringify(body); this.status = 200; this.readyState = 4;
      for (const fn of this.listeners) fn();
    }
  }
  const window = {
    CRBS: C,
    addEventListener(type, fn) { this.listener = fn; },
    postMessage(msg) { messages.push(msg); },
    fetch: (...args) => new Promise((resolve) => pending.push({ args, resolve })),
  };
  const context = vm.createContext({ window, document: { title: 'episode' }, XMLHttpRequest: XHR, Headers, Response, console, setTimeout() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/page/hook.js'), 'utf8'), context);
  window.listener({ source: window, data: { source: 'crbs-content', type: 'config', enabled: true } });
  return {
    window, messages, pending, XHR,
    async playback(id, body) {
      const p = window.fetch(playUrl(id));
      pending.at(-1).resolve(Response.json(body));
      return p;
    },
  };
}

test('manifest stream ID never becomes episode ID; external subtitle fetch and XHR signal selection', async () => {
  const h = harness();
  await h.playback('ep87', legacy());
  h.window.fetch('https://cdn/manifest/STREAM_ID/clean.mpd?crbs_sub=none');
  assert.equal(h.messages.at(-1).episodeId, 'ep87');
  assert.equal(h.messages.at(-1).lang, 'none');
  h.window.fetch('https://cdn/sub.ass?sig=x');
  assert.equal(h.messages.at(-1).lang, 'en-US');
  const xhr = new h.XHR();
  xhr.open('GET', 'https://cdn/sub.ass?sig=x');
  assert.equal(h.messages.at(-1).lang, 'en-US');
});

test('empty ad response keeps main track association; stitched videos remain untouched', async () => {
  const h = harness();
  const body = { stitchedElements: [
    { type: 'ad', textTracks: [{ language: 'ad', format: 'EXTERNAL', externalTextUrl: 'https://cdn/ad.ass' }] },
    { type: 'main', textTracks: [
      { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/sub.ass?sig=x' },
      { language: 'en-US', format: 'BURNED_IN', videoUrl: 'https://cdn/burned.mpd' },
    ] },
  ] };
  assert.deepEqual(await (await h.playback('ep87', body)).json(), body);
  await h.playback('ad', { hasAds: true });
  h.window.fetch('https://cdn/burned.mpd');
  assert.equal(h.messages.at(-1).lang, 'en-US');
  assert.equal(h.messages.at(-1).episodeId, 'ep87');
});

test('XHR playback supports JSON/text and reuse without retaining an old response', () => {
  const h = harness();
  const xhr = new h.XHR();
  xhr.responseType = 'json';
  xhr.open('GET', playUrl('ep87'));
  xhr.complete(legacy());
  assert.equal(xhr.response.hardSubs['en-US'].url, 'https://cdn/clean.mpd?crbs_sub=en-US');
  xhr.responseType = '';
  xhr.open('GET', playUrl('ep88'));
  xhr.complete({ subtitles: { 'de-DE': { format: 'ass', url: 'https://cdn/de.ass' } } });
  assert.equal(h.messages.at(-1).episodeId, 'ep88');
  assert.equal(JSON.parse(xhr.responseText).subtitles['de-DE'].url, 'https://cdn/de.ass');
});

test('late old playback response does not overwrite a newer episode', async () => {
  const h = harness();
  const old = h.window.fetch(playUrl('ep87'));
  await h.playback('ep88', legacy());
  const count = h.messages.length;
  h.pending[0].resolve(Response.json(legacy()));
  const stale = await (await old).json();
  assert.equal(stale.hardSubs['en-US'].url, 'old');
  h.window.fetch(stale.hardSubs['en-US'].url);
  assert.equal(h.messages.length, count);
});

test('stitched selection tracks each main external URL and ignores ambiguous language URLs', async () => {
  const h = harness();
  await h.playback('episode-with-segments', { stitchedElements: [
    { type: 'main', textTracks: [
      { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/part1.ass' },
      { language: 'en-US', format: 'BURNED_IN', videoUrl: 'https://cdn/shared.mpd' },
    ] },
    { type: 'ad', textTracks: [
      { language: 'ad', format: 'BURNED_IN', videoUrl: 'https://cdn/ad.mpd' },
    ] },
    { type: 'main', textTracks: [
      { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/part2.ass' },
      { language: 'de-DE', format: 'BURNED_IN', videoUrl: 'https://cdn/shared.mpd' },
      { language: 'en-US', format: 'BURNED_IN', videoUrl: 'https://cdn/shared.mpd' },
    ] },
  ] });
  h.window.fetch('https://cdn/part1.ass');
  assert.equal(h.messages.at(-1).type, 'subtitle-selected');
  assert.equal(h.messages.at(-1).lang, 'en-US');
  assert.equal(h.messages.at(-1).episodeId, 'episode-with-segments');
  const count = h.messages.length;
  h.window.fetch('https://cdn/shared.mpd');
  h.window.fetch('https://cdn/ad.mpd');
  assert.equal(h.messages.length, count);
  const xhr = new h.XHR();
  xhr.open('GET', 'https://cdn/part2.ass');
  assert.equal(h.messages.at(-1).lang, 'en-US');
});

test('a newer fetch playback keeps selection state when an older XHR finishes', async () => {
  const h = harness();
  const old = new h.XHR();
  old.responseType = 'json';
  old.open('GET', playUrl('older-episode'));
  const body = { subtitles: { 'de-DE': { format: 'ass', url: 'https://cdn/new-de.ass' } } };
  await h.playback('newer-episode', body);
  const count = h.messages.length;
  old.complete(legacy());
  assert.equal(h.messages.length, count);
  assert.equal(old.response.hardSubs['en-US'].url, 'old');
  h.window.fetch('https://cdn/new-de.ass');
  assert.equal(h.messages.at(-1).episodeId, 'newer-episode');
  assert.equal(h.messages.at(-1).lang, 'de-DE');
  const selectedCount = h.messages.length;
  h.window.fetch('https://cdn/sub.ass?sig=x');
  assert.equal(h.messages.length, selectedCount);
});

test('signed playback refresh replaces selection URLs; an ad response preserves explicit none', async () => {
  const h = harness();
  const body = legacy();
  body.hardSubs.none = { url: body.url };
  const first = await (await h.playback('same-episode', body)).json();
  body.subtitles['en-US'].url = 'https://cdn/sub.ass?sig=y';
  const latest = await (await h.playback('same-episode', body)).json();
  assert.equal(latest.hardSubs['en-US'].url, first.hardSubs['en-US'].url);
  const count = h.messages.length;
  h.window.fetch('https://cdn/sub.ass?sig=x');
  assert.equal(h.messages.length, count);
  h.window.fetch('https://cdn/sub.ass?sig=y');
  assert.equal(h.messages.at(-1).lang, 'en-US');
  h.window.fetch(latest.hardSubs.none.url);
  assert.equal(h.messages.at(-1).lang, 'none');
  await h.playback('independent-ad', { type: 'ad' });
  const xhr = new h.XHR();
  xhr.open('GET', latest.hardSubs.none.url);
  assert.equal(h.messages.at(-1).episodeId, 'same-episode');
  assert.equal(h.messages.at(-1).lang, 'none');
});

test('successful stitched clean rewrites signal the selected language through fetch/XHR and preserve none', async () => {
  for (const source of ['external', 'none']) {
    for (const transport of ['fetch', 'xhr']) {
      const h = harness();
      const noneUrl = 'https://cdn/none.mpd?sig=%2f%20';
      const externalUrl = 'https://cdn/external.mpd?sig=a%2Fb+c';
      const external = { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/full-en.ass' };
      if (source === 'external') external.videoUrl = externalUrl;
      const body = { stitchedElements: [
        { type: 'ad', videoUrl: 'https://cdn/ad.mpd', textTracks: [
          { language: 'en-US', format: 'BURNED_IN', videoUrl: 'https://cdn/ad-en.mpd' },
        ] },
        { type: 'main', textTracks: [
          { locale: 'none', videoUrl: noneUrl },
          external,
          { language: 'en-US', format: 'BURNED_IN', videoUrl: 'https://cdn/burned.mpd' },
        ] },
      ] };
      let out;
      if (transport === 'fetch') out = await (await h.playback('future-ad-episode', body)).json();
      else {
        const playback = new h.XHR();
        playback.open('GET', playUrl('future-ad-episode'));
        playback.complete(body);
        out = JSON.parse(playback.responseText);
      }
      const tracks = out.stitchedElements[1].textTracks;
      const rewritten = (source === 'external' ? externalUrl : noneUrl) + '&crbs_sub=en-US';
      assert.equal(tracks[2].videoUrl, rewritten);
      assert.equal(tracks[0].videoUrl, noneUrl);
      assert.deepEqual(out.stitchedElements[0], body.stitchedElements[0]);
      h.window.fetch(rewritten);
      assert.equal(h.messages.at(-1).type, 'subtitle-selected');
      assert.equal(h.messages.at(-1).lang, 'en-US');
      assert.equal(h.messages.at(-1).episodeId, 'future-ad-episode');
      const manifest = new h.XHR();
      manifest.open('GET', rewritten);
      assert.equal(h.messages.at(-1).lang, 'en-US');
      assert.equal(h.messages.at(-1).episodeId, 'future-ad-episode');
      h.window.fetch(noneUrl);
      assert.equal(h.messages.at(-1).lang, 'none');
      assert.equal(h.messages.at(-1).episodeId, 'future-ad-episode');
      const count = h.messages.length;
      h.window.fetch('https://cdn/ad.mpd');
      manifest.open('GET', 'https://cdn/ad-en.mpd');
      assert.equal(h.messages.length, count);
    }
  }
});

test('hybrid rewritten choices keep their language marker and the untouched none URL still signals none', async () => {
  const h = harness();
  const body = legacy();
  const clean = 'https://cdn/explicit-none.mpd?sig=x%2Fy';
  body.hardSubs.none = { url: clean };
  body.stitchedElements = [{ type: 'ad', videoUrl: 'https://cdn/ad.mpd' }];
  const out = await (await h.playback('hybrid-episode', body)).json();
  assert.equal(out.hardSubs['en-US'].url, clean + '&crbs_sub=en-US');
  assert.equal(out.hardSubs.none.url, clean);
  h.window.fetch(out.hardSubs['en-US'].url);
  assert.equal(h.messages.at(-1).lang, 'en-US');
  assert.equal(h.messages.at(-1).episodeId, 'hybrid-episode');
  const manifest = new h.XHR();
  manifest.open('GET', out.hardSubs.none.url);
  assert.equal(h.messages.at(-1).lang, 'none');
  assert.equal(h.messages.at(-1).episodeId, 'hybrid-episode');
  await h.playback('ad-id', { type: 'ad' });
  h.window.fetch(out.hardSubs.none.url);
  assert.equal(h.messages.at(-1).lang, 'none');
  assert.equal(h.messages.at(-1).episodeId, 'hybrid-episode');
  const count = h.messages.length;
  h.window.fetch(body.stitchedElements[0].videoUrl);
  assert.equal(h.messages.length, count);
});
