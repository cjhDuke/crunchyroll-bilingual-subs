const test = require('node:test');
const assert = require('node:assert/strict');
const { rewritePlayback, episodeIdFromPlayUrl, parseManifestMarker } = require('../src/core/playback.js');

const CLEAN = 'https://www.crunchyroll.com/playback/v2/manifest/X/clean/manifest.mpd?playbackGuid=g';
function sample() {
  return {
    url: CLEAN,
    hardSubs: {
      'en-US': { hlang: 'en-US', url: 'https://www.crunchyroll.com/playback/v2/manifest/X/enus/manifest.mpd?playbackGuid=g' },
      none: { hlang: 'none', url: CLEAN },
    },
    subtitles: {
      'en-US': { format: 'ass', language: 'en-US', url: 'https://cdn/enus/subtitle.ass' },
      'de-DE': { format: 'ass', language: 'de-DE', url: 'https://cdn/dede/subtitle.ass' },
      none: { language: 'none' },
    },
  };
}

// Semantic contract fixtures, not a captured Crunchyroll response.
function mainPart(part) {
  return {
    type: 'main',
    videoUrl: `https://cdn/${part}-default.mpd`,
    textTracks: [
      { locale: 'none', videoUrl: `https://cdn/${part}-none.mpd?sig=a%2Fb+c` },
      { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/whole-en.ass', videoUrl: `https://cdn/${part}-external.mpd?sig=%2f%20` },
      { locale: 'de-DE', format: 'EXTERNAL', externalTextUrl: 'https://cdn/whole-de.ass' },
      { language: 'en-US', format: 'BURNED_IN', videoUrl: `https://cdn/${part}-en.mpd` },
      { locale: 'de-DE', format: 'BURNED_IN', videoUrl: `https://cdn/${part}-de.mpd` },
      { language: 'fr-FR', format: 'BURNED_IN', videoUrl: `https://cdn/${part}-fr.mpd` },
      { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/whole-en.vtt', videoUrl: `https://cdn/${part}-vtt.mpd` },
    ],
  };
}

test('rewritePlayback points every hardsub to the clean stream with a marker', () => {
  const { json, info } = rewritePlayback(sample());
  assert.equal(json.hardSubs['en-US'].url, CLEAN + '&crbs_sub=en-US');
  assert.equal(json.hardSubs.none.url, CLEAN + '&crbs_sub=none');
  assert.deepEqual(Object.keys(info.subtitles).sort(), ['de-DE', 'en-US']);
  assert.equal(info.subtitles['en-US'].format, 'ass');
});

test('rewritePlayback tolerates missing fields', () => {
  const { json, info } = rewritePlayback({ subtitles: { 'en-US': { format: 'ass', url: 'u' } } });
  assert.equal(json.hardSubs, undefined);
  assert.equal(info.subtitles['en-US'].url, 'u');
  assert.deepEqual(rewritePlayback({}).info.subtitles, {});
});

test('rewritePlayback uses ? when clean url has no query', () => {
  const j = sample();
  j.url = 'https://x/clean.mpd';
  assert.equal(rewritePlayback(j).json.hardSubs['en-US'].url, 'https://x/clean.mpd?crbs_sub=en-US');
});

test('episodeIdFromPlayUrl and parseManifestMarker', () => {
  assert.equal(episodeIdFromPlayUrl('https://www.crunchyroll.com/playback/v4/G69P9MD9Y/web/chrome/play?locale=zh-TW'), 'G69P9MD9Y');
  assert.equal(episodeIdFromPlayUrl('https://www.crunchyroll.com/other'), null);
  assert.equal(parseManifestMarker(CLEAN + '&crbs_sub=en-US'), 'en-US');
  assert.equal(parseManifestMarker(CLEAN + '&crbs_sub=none'), 'none');
  assert.equal(parseManifestMarker(CLEAN), null);
});

test('stitched collects external main tracks and preserves all video URLs', () => {
  const json = sample();
  json.stitchedElements = ['ad', 'promo', 'preview', 'recap', 'logo', 'main', 'main_content'].map((type) => ({
    type,
    videoUrl: `https://cdn/${type}.mpd`,
    textTracks: [
      { language: type === 'main' ? 'en-US' : type, format: 'EXTERNAL', externalTextUrl: `https://cdn/${type}.ass?sig=x` },
      { language: 'fr-FR', format: 'BURNED_IN', videoUrl: 'https://cdn/fr.mpd' },
    ],
  }));
  delete json.subtitles;
  const before = JSON.stringify(json);
  const { info } = rewritePlayback(json);
  assert.equal(JSON.stringify(json), before);
  assert.deepEqual(Object.keys(info.subtitles), ['en-US', 'main_content']);
  assert.equal(info.subtitles['en-US'].format, 'ass');
  assert.equal(info.hasAds, true);
});

test('ad detection accepts payload flag, ad breaks, and stitched ad elements', () => {
  for (const json of [{ hasAds: true }, { type: 'ad' }, { ads: { adBreaks: [{}] } }, { stitchedElements: [{ type: 'ad' }] }]) {
    assert.equal(rewritePlayback(json).info.hasAds, true);
    assert.deepEqual(rewritePlayback(json).info.subtitles, {});
  }
  assert.equal(rewritePlayback({ ads: { adBreaks: [] } }).info.hasAds, false);
});

test('top-level ad and promo tracks cannot replace a main track or rewrite ad video', () => {
  for (const type of ['ad', 'promo', 'preview', 'recap', 'logo']) {
    const json = { ...sample(), type };
    const before = JSON.stringify(json);
    assert.deepEqual(rewritePlayback(json).info.subtitles, {});
    assert.equal(JSON.stringify(json), before);
  }
});

test('stitched main without a local clean candidate never borrows the top-level or another main URL', () => {
  const json = sample();
  json.stitchedElements = [
    { type: 'main', textTracks: [
      { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/part1.ass' },
      { language: 'en-US', format: 'BURNED_IN', videoUrl: 'https://cdn/part1-en.mpd' },
    ] },
    { type: 'main', videoUrl: 'https://cdn/part2.mpd', textTracks: [] },
  ];
  const before = structuredClone(json);
  const { info } = rewritePlayback(json);
  assert.deepEqual(json.stitchedElements, before.stitchedElements);
  assert.equal(json.hardSubs['en-US'].url, CLEAN + '&crbs_sub=en-US');
  assert.equal(info.subtitles['en-US'].url, 'https://cdn/part1.ass');
});

test('stitched keeps non-main URLs and main tracks without same-language ASS untouched', () => {
  const elements = ['ad', 'promo', 'recap', 'preview', 'logo'].map((type) => ({
    type,
    videoUrl: `https://cdn/${type}.mpd`,
    textTracks: [
      { language: 'en-US', format: 'EXTERNAL', externalTextUrl: `https://cdn/${type}.ass` },
      { language: 'en-US', format: 'BURNED_IN', videoUrl: `https://cdn/${type}-en.mpd` },
    ],
  }));
  elements.splice(1, 0, { type: 'main', videoUrl: 'https://cdn/main1.mpd', textTracks: [
    { language: 'de-DE', format: 'EXTERNAL', externalTextUrl: 'https://cdn/de.ass' },
    { language: 'en-US', format: 'BURNED_IN', videoUrl: 'https://cdn/en.mpd' },
  ] });
  elements.splice(4, 0, { type: 'main', videoUrl: 'https://cdn/main2.mpd', textTracks: [
    { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/en.vtt' },
    { language: 'en-US', format: 'BURNED_IN', videoUrl: 'https://cdn/en-vtt.mpd' },
  ] });
  const json = { stitchedElements: elements };
  const before = structuredClone(json);
  rewritePlayback(json);
  assert.deepEqual(json, before);
});

test('each main uses its own external ASS video or none fallback while ads before, between and after remain intact', () => {
  const other = (type, id) => Object.assign(mainPart(id), { type });
  const json = { stitchedElements: [
    other('ad', 'ad-before'), mainPart('part1'), other('promo', 'promo'),
    other('ad', 'ad-between'), mainPart('part2'), other('recap', 'recap'),
    other('preview', 'preview'), other('logo', 'logo'), other('ad', 'ad-after'),
  ] };
  const expected = structuredClone(json);
  for (const index of [1, 4]) {
    const tracks = expected.stitchedElements[index].textTracks;
    tracks[3].videoUrl = tracks[1].videoUrl + '&crbs_sub=en-US';
    tracks[4].videoUrl = tracks[0].videoUrl + '&crbs_sub=de-DE';
  }
  const { info } = rewritePlayback(json);
  assert.deepEqual(json, expected);
  assert.equal(info.hasAds, true);
  assert.equal(info.subtitles['en-US'].url, 'https://cdn/whole-en.ass');
  assert.equal(info.subtitles['en-US'].format, 'ass');
});

test('rewriting an existing marker is idempotent and preserves signed query bytes and fragments', () => {
  const source = 'https://cdn/none.mpd?Signature=a%2Fb+c&crbs_sub=none&Policy=%2f%20&crbs_sub=de-DE#chapter?crbs_sub=wrong';
  const expected = 'https://cdn/none.mpd?Signature=a%2Fb+c&crbs_sub=en-US&Policy=%2f%20#chapter?crbs_sub=wrong';
  const main = mainPart('markers');
  main.textTracks[0].videoUrl = source;
  delete main.textTracks[1].videoUrl;
  const json = { stitchedElements: [main] };
  rewritePlayback(json);
  assert.equal(main.textTracks[3].videoUrl, expected);
  assert.equal(main.textTracks[0].videoUrl, source);
  assert.equal(parseManifestMarker(main.textTracks[3].videoUrl), 'en-US');
  const once = structuredClone(json);
  rewritePlayback(json);
  assert.deepEqual(json, once);

  const legacy = sample();
  legacy.url = source;
  rewritePlayback(legacy);
  assert.equal(legacy.hardSubs['en-US'].url, expected);
  assert.equal(parseManifestMarker(legacy.hardSubs.none.url), 'none');
  const legacyOnce = structuredClone(legacy);
  rewritePlayback(legacy);
  assert.deepEqual(legacy, legacyOnce);
  legacy.url = 'https://cdn/none.mpd#chapter?crbs_sub=wrong';
  rewritePlayback(legacy);
  assert.equal(legacy.hardSubs['en-US'].url, 'https://cdn/none.mpd?crbs_sub=en-US#chapter?crbs_sub=wrong');
  assert.equal(parseManifestMarker(legacy.url), null);
});

test('ambiguous or invalid clean sources and an unproven default video leave a main unchanged', () => {
  const tracks = () => [
    { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/en.ass' },
    { language: 'en-US', format: 'BURNED_IN', videoUrl: 'https://cdn/en.mpd' },
  ];
  for (const extra of [
    [],
    [{ language: 'none', videoUrl: 'not-a-url' }],
    [{ language: 'none', videoUrl: 'https://cdn/none1.mpd' }, { language: 'none', videoUrl: 'https://cdn/none2.mpd' }],
    [{ language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/en.ass', videoUrl: 'https://cdn/a.mpd' },
      { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/en.ass', videoUrl: 'https://cdn/b.mpd' }],
  ]) {
    const json = { stitchedElements: [{ type: 'main', videoUrl: CLEAN, textTracks: tracks().concat(extra) }] };
    const before = structuredClone(json);
    rewritePlayback(json);
    assert.deepEqual(json, before);
  }
});

test('hybrid legacy choices and each main rewrite independently without touching non-main data', () => {
  const json = sample();
  const clean = 'https://cdn/explicit-none.mpd?sig=x%2Fy';
  json.hardSubs.none.url = clean;
  json.subtitles['de-DE'].format = 'vtt';
  json.hardSubs['fr-FR'] = { url: 'https://cdn/fr-burned.mpd' };
  json.stitchedElements = [Object.assign(mainPart('ad'), { type: 'ad' }), mainPart('main')];
  const expected = structuredClone(json);
  expected.hardSubs['en-US'].url = clean + '&crbs_sub=en-US';
  const tracks = expected.stitchedElements[1].textTracks;
  tracks[3].videoUrl = tracks[1].videoUrl + '&crbs_sub=en-US';
  tracks[4].videoUrl = tracks[0].videoUrl + '&crbs_sub=de-DE';
  const { info } = rewritePlayback(json);
  assert.deepEqual(json, expected);
  assert.equal(json.hardSubs.none.url, clean);
  assert.equal(json.url, CLEAN);
  assert.equal(info.subtitles['de-DE'].format, 'ass');
  const once = structuredClone(json);
  rewritePlayback(json);
  assert.deepEqual(json, once);
});

test('hybrid top-level ASS is collected even when its clean source cannot be confirmed', () => {
  for (const candidate of [undefined, 'not-a-url']) {
    const json = sample();
    if (candidate) json.hardSubs.none.url = candidate;
    else delete json.hardSubs.none;
    json.stitchedElements = [mainPart('main')];
    // Keep the root ASS as the only English external subtitle.
    json.stitchedElements[0].textTracks = json.stitchedElements[0].textTracks.filter((t) => t.language !== 'en-US');
    const before = structuredClone(json.hardSubs);
    const { info } = rewritePlayback(json);
    assert.deepEqual(json.hardSubs, before);
    assert.equal(info.subtitles['en-US'].url, json.subtitles['en-US'].url);
    assert.notEqual(json.stitchedElements[0].textTracks[2].videoUrl, 'https://cdn/main-de.mpd');
  }
});

test('same-language ASS wins over VTT in either order and across root/main track collections', () => {
  const ass = { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/en.ass' };
  const vtt = { language: 'en-US', format: 'EXTERNAL', externalTextUrl: 'https://cdn/en.vtt' };
  for (const ordered of [[ass, vtt], [vtt, ass]]) {
    const json = { stitchedElements: [{ type: 'main', textTracks: structuredClone(ordered) }] };
    assert.equal(rewritePlayback(json).info.subtitles['en-US'].url, ass.externalTextUrl);
  }
  for (const [rootFormat, mainTrack] of [['ass', vtt], ['vtt', ass]]) {
    const json = { subtitles: { 'en-US': { format: rootFormat, url: `https://cdn/root.${rootFormat}` } },
      stitchedElements: [{ type: 'main', textTracks: [mainTrack] }] };
    assert.equal(rewritePlayback(json).info.subtitles['en-US'].format, 'ass');
  }
});
