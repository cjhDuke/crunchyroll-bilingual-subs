// 大模型（OpenAI 兼容接口）请求与响应解析。
(function (root) {
  const SYSTEM_PROMPT = (lang) => [
    `你是专业的动画字幕译者。把用户给出的英文（或其他语言）字幕逐条翻译成${lang}。`,
    '要求：',
    '1. 译文口语化、简洁，符合字幕阅读习惯，保留原句的语气和情绪，不要添加解释或注释。',
    '2. 人名、地名、专有名词优先使用给定的术语表；没有的保持前后一致。',
    '3. 每条独立翻译，不要合并或拆分条目；原文中的 " / " 表示换行，译文在对应位置也用 " / " 分行。',
    '4. "上下文" 部分只用于理解剧情，不要翻译它们。',
    '5. 只输出一个 JSON 对象，键是条目编号（字符串），值是译文，例如 {"12":"译文","13":"译文"}。不要输出任何其他内容。',
  ].join('\n');

  function buildTranslateMessages({ lines, before = [], after = [], glossary = [], title = '', targetLangName }) {
    const parts = [];
    if (title) parts.push(`作品：${title}`);
    if (glossary.length) parts.push('术语表：\n' + glossary.map((g) => `${g.src} => ${g.dst}`).join('\n'));
    if (before.length) parts.push('上文（仅供参考，不翻译）：\n' + before.map(flat).join('\n'));
    if (after.length) parts.push('下文（仅供参考，不翻译）：\n' + after.map(flat).join('\n'));
    parts.push('需要翻译的条目：\n' + lines.map((l) => `[${l.id}] ${flat(l.text)}`).join('\n'));
    return [
      { role: 'system', content: SYSTEM_PROMPT(targetLangName) },
      { role: 'user', content: parts.join('\n\n') },
    ];
  }

  function flat(s) {
    return String(s).replace(/\n/g, ' / ');
  }

  function extractJson(content) {
    let s = String(content || '').replace(/```(?:json)?/gi, '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('响应中没有 JSON');
    return JSON.parse(s.slice(a, b + 1));
  }

  function parseLlmResponse(content, ids) {
    const obj = extractJson(content);
    const map = new Map();
    for (const id of ids) {
      const v = obj[String(id)];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`缺少条目 ${id}`);
      map.set(id, v.trim());
    }
    return map;
  }

  // 原文有换行时，把译文里的斜杠分行标记（/ 或全角／）还原成真正的换行；
  // 原文是单行时只去掉带空格的 " / "，保留 AC/DC 这类正常斜杠。
  function restoreLineBreaks(tr, orig) {
    const s = String(tr);
    if (String(orig).includes('\n')) {
      return s.split(/\s*[\/／]\s*/).map((p) => p.trim()).filter(Boolean).join('\n');
    }
    return s.replace(/\s+[\/／]\s+/g, ' ');
  }

  function buildGlossaryMessages({ allText, title = '', targetLangName }) {
    return [
      {
        role: 'system',
        content: [
          `你是动画字幕翻译的术语整理助手。阅读整集字幕，列出需要统一译法的人名、地名、组织、招式、称呼等专有名词，并给出${targetLangName}译名。`,
          '已知的官方或通行译名优先。最多 60 条。',
          '只输出 JSON：{"terms":[{"src":"原文","dst":"译名"}]}，不要输出其他内容。',
        ].join('\n'),
      },
      { role: 'user', content: (title ? `作品：${title}\n\n` : '') + '字幕全文：\n' + allText },
    ];
  }

  function parseGlossary(content) {
    try {
      const obj = extractJson(content);
      const terms = Array.isArray(obj.terms) ? obj.terms : [];
      return terms
        .filter((t) => t && typeof t.src === 'string' && typeof t.dst === 'string' && t.src.trim() && t.dst.trim())
        .slice(0, 60)
        .map((t) => ({ src: t.src.trim(), dst: t.dst.trim() }));
    } catch {
      return [];
    }
  }

  function parseExtraParams(str) {
    if (!str || !String(str).trim()) return {};
    const v = JSON.parse(str);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('额外参数必须是 JSON 对象');
    return v;
  }

  async function chatCompletion(settings, messages, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
    const url = String(settings.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
    const body = { model: settings.model, messages, temperature: 0.3, stream: false, ...parseExtraParams(settings.extraParams) };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey || ''}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error(`请求超时（${timeoutMs}ms）`);
      throw new Error('网络错误：' + (e && e.message));
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('响应不是 JSON：' + text.slice(0, 200)); }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string' || !content) throw new Error('响应中没有内容');
    return content;
  }

  const api = { buildTranslateMessages, parseLlmResponse, restoreLineBreaks, buildGlossaryMessages, parseGlossary, chatCompletion, parseExtraParams };
  root.CRBS = Object.assign(root.CRBS || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
