// ASS 字幕解析：提取对白、区分特效行、生成只含特效行的 ASS。
(function (root) {
  const DIALOGUE_STYLE_RE = /^(default|main|italics?|top|italicstop|flashback\w*)$/i;
  const SIGN_TAG_RE = /\\(pos|move|org)\s*\(|\\p[1-9]/;

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
    for (const line of lines) {
      const sec = /^\s*\[(.+)\]\s*$/.exec(line);
      if (sec) { section = sec[1].toLowerCase(); continue; }
      if (section.includes('styles') && line.startsWith('Style:')) {
        styleNames.push(line.slice(6).split(',')[0].trim());
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
            text: raw,
            plain: plainText(raw),
          });
        }
      }
    }
    return { events, styleNames };
  }

  function isDialogueEvent(ev) {
    return DIALOGUE_STYLE_RE.test(ev.style) && !SIGN_TAG_RE.test(ev.text) && ev.plain.length > 0;
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
