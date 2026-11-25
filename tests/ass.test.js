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
  assert.deepEqual(events.map(isDialogueEvent), [false, true, true, false, false, true, true]);
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

function track(rows) {
  return [
    '[V4+ Styles]',
    'Format: Fontname, Alignment, Name',
    'Style: Arial,7,UpperLeft',
    'Style: Arial,8,UpperCenter',
    'Style: Arial,9,UpperRight',
    'Style: Arial,8,sign_notice',
    'Style: Arial,8,Top',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...rows.map(([style, text]) => `Dialogue: 0,0:00:01.00,0:00:05.00,${style},,0,0,0,,${text}`),
  ].join('\n');
}

test('titles and ordinary upper aligned text translate; sign styles and positioned dialogue stay in ASS', () => {
  const source = track([
    ['Ep Title', '{\\pos(320,40)}Retrospective'],
    ['Title', 'Episode title'], ['Caption', 'Previously'],
    ['UpperLeft', 'Left'], ['UpperCenter', 'Center'], ['UpperRight', 'Right'],
    ['Default', '{\\an7}Inline left'], ['Default', '{\\an8}Inline center'],
    ['Default', '{\\an9}Inline right'],
    ['sign_notice', '{\\an8}Notice'],
    ['main', '{\\an8\\pos(320,40)}Positioned dialogue'],
    ['Unknown', 'Unclassified sign'],
    ['Title', '{\\move(0,0,100,100)}Moving title'],
    ['Caption', '{\\org(10,10)}Rotating caption'],
  ]);
  const { events } = parseAss(source);
  const dialogue = events.filter(isDialogueEvent);
  assert.deepEqual(dialogue.map((ev) => ev.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(dialogue.every((ev) => ev.placement === 'top'));
  const remaining = parseAss(stripDialogue(source, new Set(dialogue.map((ev) => ev.index)))).events;
  assert.deepEqual(remaining.map((ev) => ev.plain), [
    'Notice', 'Positioned dialogue', 'Unclassified sign', 'Moving title', 'Rotating caption',
  ]);
});

test('inline alignment overrides top style including an explicit bottom override', () => {
  const { events } = parseAss(track([
    ['UpperLeft', '{\\an2}Bottom'],
    ['Top', '{\\an9}Upper right'],
    ['Ep Title', '{\\an8\\an2}Bottom title'],
    ['Default', '{\\an9}Upper right'],
  ]));
  assert.deepEqual(events.map((ev) => ev.alignment), [2, 9, 2, 9]);
  assert.deepEqual(events.map((ev) => ev.placement), ['bottom', 'top', 'bottom', 'top']);
  assert.equal(isDialogueEvent(events[2]), true);
});

test('bottom-centered custom styles translate and explicitly marked effects stay in ASS', () => {
  const source = [
    '[V4+ Styles]', 'Format: Name, Alignment', 'Style: CustomEnglish,2', 'Style: Other,4', 'Style: sign_notice,2',
    '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...[
      ['CustomEnglish', '', '', 'A line of dialogue'],
      ['Other', '', '', '{\\an2}Inline alignment'],
      ['Other', '', '', 'Middle-aligned text'],
      ['CustomEnglish', '', '', '{\\an5}Inline middle alignment'],
      ['sign_notice', '', '', 'Sign style'],
      ['CustomEnglish', 'Sign', '', 'Named sign'],
      ['CustomEnglish', '', 'Banner;50', 'Scrolling text'],
      ['CustomEnglish', '', '', '{\\pos(100,300)}Positioned text'],
      ['CustomEnglish', '', '', '{\\move(0,0,10,10)}Moving text'],
      ['CustomEnglish', '', '', '{\\p1}m 0 0 l 10 10'],
    ].map(([style, name, effect, text]) => `Dialogue: 0,0:00:01.00,0:00:05.00,${style},${name},0,0,0,${effect},${text}`),
  ].join('\n');
  const { events } = parseAss(source);
  const dialogue = events.filter(isDialogueEvent);
  assert.deepEqual(dialogue.map((ev) => ev.plain), ['A line of dialogue', 'Inline alignment']);
  assert.ok(dialogue.every((ev) => ev.placement === 'bottom'));
  const signs = parseAss(stripDialogue(source, new Set(dialogue.map((ev) => ev.index)))).events;
  assert.deepEqual(signs.map((ev) => ev.text), events.slice(2).map((ev) => ev.text));
});

test('pure and mixed drawing events stay intact and never enter translation input', () => {
  const source = track([
    ['Title', '{\\an8\\p1}m 0 0 l 10 10{\\p0}'],
    ['Ep Title', '{\\pos(10,10)}Text{\\p01}m 0 0 l 10 10{\\p0}More text'],
    ['Default', '{\\p2}m 0 0{\\bord1}l 10 10{\\p0}Text'],
    ['Caption', '{\\p0}Real text'],
  ]);
  const { events } = parseAss(source);
  const dialogue = events.filter(isDialogueEvent);
  assert.deepEqual(dialogue.map((ev) => ev.plain), ['Real text']);
  const remaining = parseAss(stripDialogue(source, new Set(dialogue.map((ev) => ev.index)))).events;
  assert.deepEqual(remaining.map((ev) => ev.text), events.slice(0, 3).map((ev) => ev.text));
});

test('static title position determines region despite bottom style anchor; missing resolution defaults to top', () => {
  const source = [
    '[Script Info]', 'PlayResX: 640', 'PlayResY: 720',
    '[V4+ Styles]', 'Format: Name, Alignment',
    'Style: Ep Title,2', 'Style: Title,2', 'Style: Caption,2', 'Style: Default,2',
    '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...[
      ['Ep Title', '{\\pos(320,40)}Top title'],
      ['Title', '{\\pos(320,600)}Bottom title'],
      ['Caption', '{\\pos(320,360)}Middle boundary'],
      ['Ep Title', '{\\an2}Unpositioned bottom'],
      ['Ep Title', '{\\an2\\pos(320,40)}Top despite bottom anchor'],
      ['Title', '{\\an8\\pos(320,600)}Bottom despite top anchor'],
      ['Default', '{\\pos(320,40)}Ordinary positioned text'],
      ['Ep Title', '{\\pos(320,40)\\p1}m 0 0 l 10 10{\\p0}'],
    ].map(([style, text]) => `Dialogue: 0,0:00:01.00,0:00:05.00,${style},,0,0,0,,${text}`),
  ].join('\n');
  const { events } = parseAss(source);
  assert.deepEqual(events.slice(0, 6).map((ev) => ev.placement), ['top', 'bottom', 'bottom', 'bottom', 'top', 'bottom']);
  assert.deepEqual(events.slice(0, 6).map((ev) => ev.alignment), [2, 2, 2, 2, 2, 8]);
  assert.deepEqual(events.map(isDialogueEvent), [true, true, true, true, true, true, false, false]);
  const withoutResolution = parseAss(source.replace('PlayResY: 720', '')).events;
  assert.deepEqual(withoutResolution.slice(0, 6).map((ev) => ev.placement), ['top', 'top', 'top', 'bottom', 'top', 'top']);
});

test('full Episode Title names translate without admitting sign title styles', () => {
  const source = '[Script Info]\nPlayResY: 360\n' + track([
    ['Episode Title', '{\\pos(320,40)}Spelled out'],
    ['Episode_Title', '{\\pos(320,300)}Underscore'],
    ['sign_Episode_Title', '{\\an8}Sign title'],
  ]).replace('Style: Arial,8,Top', 'Style: Arial,8,Top\nStyle: Arial,2,Episode Title\nStyle: Arial,2,Episode_Title');
  const { events } = parseAss(source);
  assert.deepEqual(events.map(isDialogueEvent), [true, true, false]);
  assert.deepEqual(events.slice(0, 2).map((ev) => ev.placement), ['top', 'bottom']);
  const signs = parseAss(stripDialogue(source, new Set(events.filter(isDialogueEvent).map((ev) => ev.index)))).events;
  assert.deepEqual(signs.map((ev) => ev.style), ['sign_Episode_Title']);
});
