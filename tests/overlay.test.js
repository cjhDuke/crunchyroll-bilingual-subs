const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
  return { style: {}, children: [], textContent: '', isConnected: true,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }, remove() { this.isConnected = false; } };
}

function harness() {
  const instances = [];
  const context = vm.createContext({ document: { createElement: element, querySelector: () => null },
    CRBS: { restoreLineBreaks: (text) => text },
    ASS: class { constructor(text, video, options) { this.text = text; this.video = video; this.options = options; this.seek(); instances.push(this); }
      get delay() { return this.offset || 0; }
      set delay(value) { this.delayWrites = (this.delayWrites || 0) + 1; this.offset = value; this.seek(); }
      seek() { this.activeTime = this.video.currentTime - (this.offset || 0); }
      hide() { this.hidden = true; } show() { this.hidden = false; }
      destroy() { this.destroyed = true; } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/overlay.js'), 'utf8'), context);
  const overlay = new context.CRBS.Overlay();
  overlay.topEl = element(); overlay.bottomEl = element(); overlay.signsEl = element();
  overlay.layout = () => 720;
  return { overlay, instances };
}

test('positioned ASS refreshes only on changed text, destroys prior instance, and applies mode and offset live', () => {
  const { overlay, instances } = harness();
  overlay.video = { currentTime: 0, paused: true };
  let generated = 'ASS one';
  const modesSeen = [];
  const positionedAss = (options, getLine) => { modesSeen.push(options.displayMode + ':' + options.translationPosition); assert.equal(getLine(2).t, '譯文'); return generated + ':' + options.displayMode + ':' + options.translationPosition; };
  overlay.session = { getLine: () => ({ t: '譯文' }) };
  overlay.setOptions({ displayMode: 'translation', subtitleOffsetSeconds: 1 });
  overlay.setTrack({ dialogue: [{ index: 2, style: 'Default', start: 0, end: 2, plain: 'Line' }], positionedAss });
  overlay.session = { getLine: () => ({ t: '譯文' }) };
  overlay.refreshPositioned();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].offset, 1);
  assert.equal(instances[0].activeTime, -1);
  assert.notEqual(instances[0].hidden, true);
  overlay.refreshPositioned();
  assert.equal(instances.length, 1);
  const generatorCallsBeforeRender = modesSeen.length;
  const delayWritesBeforeRender = instances[0].delayWrites;
  overlay.renderAt(0, 720);
  overlay.renderAt(0, 720);
  assert.equal(modesSeen.length, generatorCallsBeforeRender);
  assert.equal(instances[0].delayWrites, delayWritesBeforeRender);
  overlay.setOptions({ subtitleOffsetSeconds: 1 });
  assert.equal(instances[0].delayWrites, delayWritesBeforeRender);
  overlay.refreshPositioned();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].delayWrites, delayWritesBeforeRender);
  overlay.setOptions({ displayMode: 'bilingual', translationPosition: 'bottom', subtitleOffsetSeconds: -0.5 });
  assert.equal(instances.length, 2);
  assert.equal(instances[0].destroyed, true);
  assert.equal(instances[1].offset, -0.5);
  assert.equal(instances[1].activeTime, 0.5);
  assert.equal(instances[1].delayWrites, 1);
  assert.deepEqual(modesSeen.slice(-1), ['bilingual:bottom']);
  generated = 'ASS two'; overlay.refreshPositioned();
  assert.equal(instances.length, 3);
  assert.equal(instances[1].destroyed, true);
  overlay.clear();
  assert.equal(instances[2].destroyed, true);
});

test('ordinary dialogue layout remains intact alongside positioned ASS and translation mode does not hide its container', () => {
  const { overlay, instances } = harness();
  overlay.video = { currentTime: 1, paused: true };
  const dialogue = [{ index: 0, style: 'Default', start: 0, end: 2, plain: 'English' }];
  overlay.session = { getLine: () => ({ t: '中文' }) };
  overlay.setTrack({ dialogue, positionedAss: () => 'positioned' });
  overlay.refreshPositioned();
  overlay.renderAt(1, 720);
  assert.equal(overlay.bottomEl.children.length, 1);
  assert.deepEqual(overlay.bottomEl.children[0].children.map((n) => n.textContent), ['中文', 'English']);
  overlay.setOptions({ displayMode: 'translation' });
  assert.notEqual(instances[0].hidden, true);
  assert.equal(overlay.signsEl.style.visibility, undefined);
  overlay.renderAt(1, 720);
  assert.deepEqual(overlay.bottomEl.children[0].children.map((n) => n.textContent), ['中文']);
});

test('pause, seek, and track replacement preserve offset timing and replace positioned ASS', () => {
  const { overlay, instances } = harness();
  overlay.video = { currentTime: 10, paused: true };
  overlay.setTrack({ dialogue: [{ index: 0, style: 'Default', start: 8, end: 12, plain: 'A' }], positionedAss: () => 'A' });
  overlay.session = { getLine: () => ({ t: '甲' }) };
  overlay.setOptions({ subtitleOffsetSeconds: 2 });
  overlay.refreshPositioned(); overlay.renderAt(overlay.video.currentTime - 2, 720);
  assert.equal(overlay.bottomEl.children.length, 1);
  overlay.video.currentTime = 15; overlay.ass.seek(); overlay.renderAt(overlay.video.currentTime - 2, 720);
  assert.equal(overlay.bottomEl.children.length, 0);
  overlay.setTrack({ dialogue: [], positionedAss: () => 'B' });
  overlay.refreshPositioned();
  assert.equal(instances.length, 2);
  assert.equal(instances[0].destroyed, true);
});
