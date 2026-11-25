const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseAss, isDialogueEvent, stripDialogue } = require('../src/core/ass.js');

// 最小 DOM 替身：验证真实 render 生成的节点及上下区域，不引入浏览器依赖。
function element() {
  return {
    style: {}, children: [], textContent: '',
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  };
}

test('simultaneous translated title and dialogue occupy separate areas without duplicate ASS rendering', () => {
  const context = vm.createContext({
    document: { createElement: element },
    CRBS: { restoreLineBreaks: (text) => text },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/overlay.js'), 'utf8'), context);
  const source = [
    '[Script Info]', 'PlayResX: 640', 'PlayResY: 360',
    '[V4+ Styles]', 'Format: Name, Alignment',
    'Style: Default,2', 'Style: Upper,8', 'Style: Top,8', 'Style: Ep Title,2',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    'Dialogue: 0,0:00:01.00,0:00:05.00,Ep Title,,0,0,0,,{\\pos(320,30)}Retrospective',
    'Dialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,Hello',
    'Dialogue: 0,0:00:01.00,0:00:05.00,Upper,,0,0,0,,Above',
    'Dialogue: 0,0:00:01.00,0:00:05.00,Top,,0,0,0,,{\\an2}Below',
    'Dialogue: 0,0:00:01.00,0:00:05.00,Ep Title,,0,0,0,,{\\pos(320,320)}Bottom title',
    'Dialogue: 0,0:00:01.00,0:00:05.00,sign_notice,,0,0,0,,Notice',
    'Dialogue: 0,0:00:01.00,0:00:05.00,Title,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}Label',
  ].join('\n');
  const dialogue = parseAss(source).events.filter(isDialogueEvent);
  const overlay = new context.CRBS.Overlay();
  overlay.topEl = element();
  overlay.bottomEl = element();
  const translations = ['回顾', '你好', '上方', '下方', '底部标题'];
  overlay.setSession({ getLine: (index) => ({ t: translations[index] }) });
  overlay.render(dialogue, 720);
  const contents = (region) => region.children.map((line) => line.children.map((node) => node.textContent));
  assert.deepEqual(contents(overlay.topEl), [['回顾', 'Retrospective'], ['上方', 'Above']]);
  assert.deepEqual(contents(overlay.bottomEl), [['你好', 'Hello'], ['下方', 'Below'], ['底部标题', 'Bottom title']]);

  const signs = parseAss(stripDialogue(source, new Set(dialogue.map((ev) => ev.index)))).events;
  assert.deepEqual(signs.map((ev) => ev.plain), ['Notice', 'm 0 0 l 10 10Label']);
  assert.ok(signs.every((ev) => !isDialogueEvent(ev)));

  overlay.setOptions({ displayMode: 'translation' });
  overlay.render(dialogue, 720);
  assert.deepEqual(contents(overlay.topEl), [['回顾'], ['上方']]);
  assert.deepEqual(contents(overlay.bottomEl), [['你好'], ['下方'], ['底部标题']]);
  overlay.setOptions({ displayMode: 'original' });
  overlay.render(dialogue, 720);
  assert.deepEqual(contents(overlay.topEl), [['Retrospective'], ['Above']]);
});

function overlayHarness() {
  const signs = [];
  const context = vm.createContext({
    document: { createElement: element },
    CRBS: { restoreLineBreaks: (text) => text },
    ASS: class {
      constructor() { signs.push(this); }
      set delay(value) { this.offset = value; this.refreshes = (this.refreshes || 0) + 1; }
      hide() { this.hidden = true; }
      show() { this.hidden = false; }
      destroy() { this.destroyed = true; }
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/overlay.js'), 'utf8'), context);
  const overlay = new context.CRBS.Overlay();
  overlay.topEl = element(); overlay.bottomEl = element(); overlay.signsEl = element();
  overlay.layout = () => 720;
  return { overlay, signs };
}

test('translation mode never falls back to original for missing, empty or pending translations', () => {
  const { overlay } = overlayHarness();
  const events = [0, 1, 2, 3].map((index) => ({ index, style: 'Default', plain: 'English ' + index }));
  overlay.setSession({ getLine: (i) => [undefined, { t: '' }, { t: '  ' }, { t: '你好' }][i] });
  overlay.setOptions({ displayMode: 'translation' });
  overlay.render(events, 720);
  assert.equal(overlay.bottomEl.children.length, 1);
  assert.equal(overlay.bottomEl.children[0].children[0].textContent, '你好');
  overlay.setSession(null); overlay.render(events, 720);
  assert.equal(overlay.bottomEl.children.length, 0);
  overlay.setOptions({ displayMode: 'bilingual' }); overlay.render(events, 720);
  assert.equal(overlay.bottomEl.children.length, 4);
  assert.equal(overlay.bottomEl.children[0].children[0].textContent, 'English 0');
  overlay.setOptions({ displayMode: 'original' }); overlay.render(events, 720);
  assert.equal(overlay.bottomEl.children[0].children[0].textContent, 'English 0');
});

test('paused dialogue and rebuilt ASS effects share positive/negative delay; modes hide/show effects', () => {
  const { overlay, signs } = overlayHarness();
  overlay.video = { currentTime: 1, paused: true };
  overlay.dialogue = [{ index: 0, style: 'Default', start: 0, end: 2, plain: 'English' }];
  overlay.setSession({ getLine: () => ({ t: '译文' }) });
  overlay.signsAss = 'ASS'; overlay.rebuildSigns();
  assert.equal(signs[0].offset, 0);
  overlay.setOptions({ subtitleOffsetSeconds: 2, displayMode: 'translation' });
  assert.equal(overlay.bottomEl.children.length, 0); // -1 秒不能提前显示 0 秒字幕。
  assert.equal(signs[0].offset, 2);
  assert.equal(signs[0].hidden, true);
  assert.equal(overlay.signsEl.style.visibility, 'hidden');
  overlay.setOptions({ subtitleOffsetSeconds: -0.5 });
  assert.equal(overlay.bottomEl.children[0].children[0].textContent, '译文');
  assert.equal(signs[0].offset, -0.5);
  overlay.rebuildSigns();
  assert.equal(signs[0].destroyed, true);
  assert.equal(signs[1].offset, -0.5);
  assert.equal(signs[1].hidden, true);
  for (const displayMode of ['bilingual', 'original']) {
    overlay.setOptions({ displayMode });
    assert.equal(signs[1].hidden, false);
    assert.equal(overlay.signsEl.style.visibility, 'visible');
  }
  assert.ok(signs[1].refreshes >= 3);
});
