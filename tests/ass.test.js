const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAss, plainText, isDialogueEvent, stripDialogue, hashString } = require('../src/core/ass.js');

const SAMPLE = [
  '[Script Info]',
  'Title: English (US)',
  'ScriptType: v4.00+',
  'PlayResX: 640',
  'PlayResY: 360',
  '',
  '[V4+ Styles]',
  'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,Strikeout,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
  'Style: main,Trebuchet MS,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,0010,0010,0018,0',
  '',
  '[Events]',
  'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
  'Dialogue: 0,0:00:08.81,0:00:12.61,sign_303_1_A_Village_Out_in,Sign,0000,0000,0000,,A Village Out in the Boonies: Hage',
  'Dialogue: 0,0:00:14.83,0:00:16.46,main,Father,0000,0000,0000,,Here we go again...',
  'Dialogue: 0,0:00:24.25,0:00:26.10,italicstop,Father,0000,0000,0000,,{\\i1}There, there...{\\i0}\\NOkay,\\hnow.',
  'Dialogue: 0,1:02:03.50,1:02:04.00,main,,0000,0000,0000,,{\\pos(320,50)}Positioned, still',
  'Dialogue: 0,0:01:00.00,0:01:01.00,Default,,0000,0000,0000,,{\\p1}m 0 0 l 10 0 10 10{\\p0}',
  'Dialogue: 0,0:01:02.00,0:01:03.00,Ep Title,,0000,0000,0000,,Asta and Yuno',
  'Dialogue: 0,0:01:04.00,0:01:05.00,flashbackitalics,,0000,0000,0000,,Text, with, commas',
  'Comment: 0,0:01:04.00,0:01:05.00,main,,0000,0000,0000,,ignored',
].join('\r\n');

test('parseAss extracts dialogue events with seconds and plain text', () => {
  const { events } = parseAss(SAMPLE);
  assert.equal(events.length, 7);
  assert.equal(events[0].index, 0);
  assert.equal(events[0].style, 'sign_303_1_A_Village_Out_in');
  assert.equal(events[1].start, 14.83);
  assert.equal(events[1].end, 16.46);
  assert.equal(events[1].name, 'Father');
  assert.equal(events[2].plain, 'There, there...\nOkay, now.');
  assert.equal(events[3].start, 3723.5);
  assert.equal(events[6].text, 'Text, with, commas');
});

test('plainText strips override tags and converts breaks', () => {
  assert.equal(plainText('{\\an8}Hello\\Nworld\\h!'), 'Hello\nworld !');
  assert.equal(plainText('  {\\b1}{\\i1}  '), '');
});

test('isDialogueEvent separates dialogue from signs and drawings', () => {
  const { events } = parseAss(SAMPLE);
  assert.deepEqual(events.map(isDialogueEvent), [false, true, true, false, false, false, true]);
});

test('stripDialogue removes only the given dialogue lines', () => {
  const out = stripDialogue(SAMPLE, new Set([1, 2]));
  assert.ok(out.includes('[Script Info]'));
  assert.ok(out.includes('Style: main'));
  assert.ok(out.includes('A Village Out in the Boonies'));
  assert.ok(!out.includes('Here we go again'));
  assert.ok(!out.includes('There, there'));
  assert.ok(out.includes('Text, with, commas'));
});

test('hashString is stable and differs by content', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
  assert.match(hashString('abc'), /^[0-9a-f]{8}$/);
});
