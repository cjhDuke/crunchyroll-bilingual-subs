const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSubtitleOffset: normalize, subtitleOffsetKey, DEFAULT_SETTINGS } = require('../src/shared/settings.js');

test('subtitle offset clamps, rounds by half a second and stays outside global settings', () => {
  assert.equal(normalize(900), 600);
  assert.equal(normalize(-900), -600);
  assert.equal(normalize(1.26), 1.5);
  assert.equal(normalize(-1.26), -1.5);
  for (const input of [undefined, NaN, Infinity, 'invalid']) assert.equal(normalize(input), 0);
  assert.notEqual(subtitleOffsetKey('A'), subtitleOffsetKey('B'));
  assert.equal(DEFAULT_SETTINGS.subtitleOffsetSeconds, undefined);
});
