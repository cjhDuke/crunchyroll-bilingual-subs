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
