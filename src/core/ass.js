// 解析 ASS 可读文本，生成保留原位与时序的字幕轨。
(function (root) {
  const DIALOGUE_STYLE_RE = /^(default|main|italics?|top|italicstop|flashback\w*)$/i;
  const TITLE_STYLE_RE = /^(ep(?:isode)?[\s_-]*title|title|caption)$/i;
  const SIGN_STYLE_RE = /^sign(?:[_\s-]|$)/i;
  const NATIVE_LAYOUT_RE = /\\(?:pos|move|org)\s*\(|\\a\d/i;
  const POSITION_TAG_RE = /\\(?:(?:pos|move|org)\s*\([^)]*\)|an[1-9](?!\d)|a\d{1,2}(?!\d))/gi;
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
    let drawing = false, out = '', cursor = 0;
    for (const m of raw.matchAll(/\{[^}]*\}/g)) {
      if (!drawing) out += raw.slice(cursor, m.index);
      const switches = [...m[0].matchAll(/\\p\s*(\d+)/gi)];
      if (switches.length) drawing = Number(switches[switches.length - 1][1]) > 0;
      cursor = m.index + m[0].length;
    }
    if (!drawing) out += raw.slice(cursor);
    return out.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').split('\n').map((s) => s.trim()).join('\n').trim();
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
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber];
      const sec = /^\s*\[(.+)\]\s*$/.exec(line);
      if (sec) { section = sec[1].toLowerCase(); continue; }
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
          const body = line.slice(9).replace(/^\s/, '');
          const textIndex = format.findIndex((name) => name.toLowerCase() === 'text');
          const f = splitAssFields(body, format.length, textIndex < 0 ? format.length - 1 : textIndex);
          if (!f) continue;
          const get = (k) => (f[format.findIndex((name) => name.toLowerCase() === k)] ?? '').trim();
          const raw = f[textIndex] ?? '';
          events.push({
            index: events.length,
            lineNumber,
            start: toSeconds(get('start')),
            end: toSeconds(get('end')),
            style: get('style'),
            name: get('name'),
            effect: get('effect'),
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
    }
    return { events, styleNames };
  }

  function splitAssFields(body, count, textIndex) {
    const left = body.split(',');
    if (left.length < count) return null;
    if (textIndex === count - 1) return splitFields(body, count);
    const result = [];
    let rest = body;
    for (let i = 0; i < textIndex; i++) { const p = rest.indexOf(','); if (p < 0) return null; result.push(rest.slice(0, p)); rest = rest.slice(p + 1); }
    const suffixCount = count - textIndex - 1;
    const suffix = [];
    for (let i = 0; i < suffixCount; i++) { const p = rest.lastIndexOf(','); if (p < 0) return null; suffix.unshift(rest.slice(p + 1)); rest = rest.slice(0, p); }
    return [...result, rest, ...suffix];
  }

  function isDialogueEvent(ev) {
    const tags = overrideTags(ev.text);
    const title = TITLE_STYLE_RE.test(ev.style);
    const knownStyle = title || DIALOGUE_STYLE_RE.test(ev.style);
    // 仅普通上下居中字幕使用自绘层，其他布局交给 ASS.js。
    const centered = ev.alignment == null ? knownStyle : ev.alignment === 2 || ev.alignment === 8;
    return !SIGN_STYLE_RE.test(ev.style) && !SIGN_STYLE_RE.test(ev.name) && !ev.effect
      && !DRAWING_TAG_RE.test(tags) && !NATIVE_LAYOUT_RE.test(tags) && centered && ev.plain.length > 0;
  }

  function stripDialogue(text, dialogueIndexSet) {
    let section = '';
    const byLine = new Map(parseAss(text).events.map((ev) => [ev.lineNumber, ev]));
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber];
      const sec = /^\s*\[(.+)\]\s*$/.exec(line);
      if (sec) section = sec[1].toLowerCase();
      if (section === 'events' && line.startsWith('Dialogue:')) {
        const ev = byLine.get(lineNumber);
        if (ev && dialogueIndexSet.has(ev.index)) continue;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  function isTranslatableAssEvent(ev) {
    return !!ev && Number.isFinite(ev.start) && Number.isFinite(ev.end) && ev.end > ev.start && !!ev.plain?.trim();
  }

  function encodeLiteral(value) {
    // ASS 没有可靠的字面花括号或反斜线转义，保留可读字符并阻止译文注入标签。
    return value.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r\n?|\n/g, '\\N');
  }

  function createPositionedAss(text, events, dialogueSet) {
    const lines = text.split(/\r?\n/);
    const byLine = new Map(events.map((ev) => [ev.lineNumber, ev]));
    return function renderPositionedAss(options = {}, getLine = () => undefined) {
      const mode = options.displayMode || 'bilingual';
      let section = '', format = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
      const out = [];
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const line = lines[lineNumber];
        const sec = /^\s*\[(.+)\]\s*$/.exec(line);
        if (sec) section = sec[1].toLowerCase();
        if (section === 'events' && line.startsWith('Format:')) { format = line.slice(7).split(',').map((s) => s.trim()); out.push(line); continue; }
        if (section !== 'events' || !line.startsWith('Dialogue:')) { out.push(line); continue; }
        const ev = byLine.get(lineNumber);
        if (!ev) {
          if (mode !== 'translation') out.push(line);
          continue;
        }
        if (dialogueSet.has(ev.index)) continue;
        const data = mode !== 'original' && isTranslatableAssEvent(ev) ? getLine(ev.index) : null;
        const translated = typeof data?.t === 'string' ? encodeLiteral(data.t.trim()) : '';
        if (!translated) {
          if (mode !== 'translation') out.push(line);
          continue;
        }
        const replacement = positionedText(ev.text, translated, mode, options.translationPosition);
        out.push(replaceTextField(line, format.findIndex((s) => s.toLowerCase() === 'text'), format.length, replacement));
      }
      return out.join('\n');
    };
  }

  function positionedText(raw, translated, mode, translationPosition) {
    const tags = overrideTags(raw);
    if (mode === 'translation') {
      const geometry = tags.match(POSITION_TAG_RE) || [];
      return (geometry.length ? `{${geometry.join('')}}` : '') + translated;
    }
    if (translationPosition !== 'bottom') return translated + '\\N' + raw;
    // 绘图结束后切回文字模式，确保译文不会被当作路径。
    const reset = DRAWING_TAG_RE.test(tags) ? '{\\p0}' : '';
    return raw + reset + '\\N' + translated;
  }

  function commaAt(line, count) {
    let p = 9;
    for (let i = 0; i < count; i++) { p = line.indexOf(',', p); if (p < 0) return line.length - 1; p++; }
    return p - 1;
  }

  function replaceTextField(line, textIndex, fieldCount, replacement) {
    if (textIndex < 0) return line;
    const startComma = commaAt(line, textIndex);
    const start = startComma + 1;
    if (textIndex === fieldCount - 1) return line.slice(0, start) + replacement;
    const end = commaAtFromRight(line, fieldCount - textIndex - 1);
    return line.slice(0, start) + replacement + line.slice(end);
  }

  function commaAtFromRight(line, count) {
    let p = line.length;
    for (let i = 0; i < count; i++) { p = line.lastIndexOf(',', p - 1); if (p < 0) return line.length; }
    return p;
  }

  function hashString(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  const api = { parseAss, plainText, isDialogueEvent, isTranslatableAssEvent, createPositionedAss, stripDialogue, hashString };
  root.CRBS = Object.assign(root.CRBS || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
