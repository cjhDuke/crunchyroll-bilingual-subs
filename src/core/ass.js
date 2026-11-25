// ASS 字幕解析：提取对白、区分特效行、生成只含特效行的 ASS。
(function (root) {
  const DIALOGUE_STYLE_RE = /^(default|main|italics?|top|italicstop|flashback\w*)$/i;
  const TITLE_STYLE_RE = /^(ep(?:isode)?[\s_-]*title|title|caption)$/i;
  const SIGN_STYLE_RE = /^sign(?:[_\s-]|$)/i;
  const SIGN_TAG_RE = /\\(pos|move|org)\s*\(/i;
  const TITLE_EFFECT_TAG_RE = /\\(move|org)\s*\(/i;
  const DRAWING_TAG_RE = /\\p\s*0*[1-9]\d*(?![\d.])/i;

  function overrideTags(raw) {
    return (raw.match(/\{[^}]*\}/g) || []).join('');
  }

  function toSeconds(ts) {
    const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(ts.trim());
    if (!m) return NaN;
    return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) / 1000;
  }

  function plainText(raw) {
    return raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .split('\n')
      .map((s) => s.trim())
      .join('\n')
      .trim();
  }

  // 按 Format 行字段数切分，Text 字段可以包含逗号。
  function splitFields(body, count) {
    const out = [];
    let rest = body;
    for (let i = 0; i < count - 1; i++) {
      const p = rest.indexOf(',');
      if (p < 0) return null;
      out.push(rest.slice(0, p));
      rest = rest.slice(p + 1);
    }
    out.push(rest);
    return out;
  }

  function parseAss(text) {
    const lines = text.split(/\r?\n/);
    let section = '';
    let format = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
    const events = [];
    const styleNames = [];
    let styleFormat = [];
    const alignments = new Map();
    let playResY = 0;
    for (const line of lines) {
      const sec = /^\s*\[(.+)\]\s*$/.exec(line);
      if (sec) { section = sec[1].toLowerCase(); continue; }
      if (section === 'script info' && /^\s*PlayResY\s*:/i.test(line)) {
        const height = Number(line.slice(line.indexOf(':') + 1).trim());
        if (Number.isFinite(height) && height > 0) playResY = height;
      }
      if (section.includes('styles') && line.startsWith('Format:')) {
        styleFormat = line.slice(7).split(',').map((s) => s.trim().toLowerCase());
      } else if (section.includes('styles') && line.startsWith('Style:')) {
        const fields = line.slice(6).split(',').map((s) => s.trim());
        const name = fields[styleFormat.indexOf('name')] ?? fields[0];
        styleNames.push(name);
        const alignment = Number(fields[styleFormat.indexOf('alignment')]);
        if (alignment >= 1 && alignment <= 9) alignments.set(name.toLowerCase(), alignment);
      } else if (section === 'events') {
        if (line.startsWith('Format:')) {
          format = line.slice(7).split(',').map((s) => s.trim());
        } else if (line.startsWith('Dialogue:')) {
          const f = splitFields(line.slice(9).replace(/^\s/, ''), format.length);
          if (!f) continue;
          const get = (k) => (f[format.indexOf(k)] ?? '').trim();
          const raw = f[format.indexOf('Text')] ?? '';
          events.push({
            index: events.length,
            start: toSeconds(get('Start')),
            end: toSeconds(get('End')),
            style: get('Style'),
            name: get('Name'),
            effect: get('Effect'),
            text: raw,
            plain: plainText(raw),
          });
        }
      }
    }
    for (const ev of events) {
      const tags = overrideTags(ev.text);
      // 行内对齐覆盖样式；显式底部对齐也必须覆盖标题/Top 名称。
      const inline = [...tags.matchAll(/\\an([1-9])(?!\d)/g)];
      ev.alignment = inline.length ? Number(inline[inline.length - 1][1]) : alignments.get(ev.style.toLowerCase());
      ev.placement = ev.alignment != null
        ? (ev.alignment >= 7 ? 'top' : 'bottom')
        : (TITLE_STYLE_RE.test(ev.style) || /top/i.test(ev.style) ? 'top' : 'bottom');
      if (TITLE_STYLE_RE.test(ev.style) && isDialogueEvent(ev)) {
        const pos = /\\pos\s*\(\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\)/i.exec(tags);
        // pos 是实际坐标，Alignment 只是锚点；标题仅按画面上下半区显示。
        if (pos) ev.placement = !playResY || Number(pos[1]) < playResY / 2 ? 'top' : 'bottom';
      }
    }
    return { events, styleNames };
  }

  function isDialogueEvent(ev) {
    const tags = overrideTags(ev.text);
    const title = TITLE_STYLE_RE.test(ev.style);
    // 自定义样式也可用于普通底部居中对白。显式招牌或特效仍按原样渲染。
    const bottomDialogue = ev.alignment === 2 && !ev.effect && !SIGN_STYLE_RE.test(ev.name);
    // 混合绘图/文字事件整体保留，避免路径进入翻译或丢失绘图。
    return !SIGN_STYLE_RE.test(ev.style) && !DRAWING_TAG_RE.test(tags)
      && (title || DIALOGUE_STYLE_RE.test(ev.style) || ev.alignment >= 7 || bottomDialogue)
      && !(title ? TITLE_EFFECT_TAG_RE : SIGN_TAG_RE).test(tags) && ev.plain.length > 0;
  }

  function stripDialogue(text, dialogueIndexSet) {
    let section = '';
    let i = -1;
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const sec = /^\s*\[(.+)\]\s*$/.exec(line);
      if (sec) section = sec[1].toLowerCase();
      if (section === 'events' && line.startsWith('Dialogue:')) {
        i++;
        if (dialogueIndexSet.has(i)) continue;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  function hashString(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  const api = { parseAss, plainText, isDialogueEvent, stripDialogue, hashString };
  root.CRBS = Object.assign(root.CRBS || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
