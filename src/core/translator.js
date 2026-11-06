// 单批翻译：大模型（含 1 次重试）→ 失败回退谷歌。
(function (root) {
  const C = typeof module !== 'undefined' ? require('./llm.js') : root.CRBS;

  const LANGS = [
    { code: 'zh-CN', name: '简体中文', google: 'zh-CN' },
    { code: 'zh-TW', name: '繁體中文（台灣用語）', google: 'zh-TW' },
    { code: 'en', name: 'English', google: 'en' },
    { code: 'ja', name: '日本語', google: 'ja' },
    { code: 'ko', name: '한국어', google: 'ko' },
    { code: 'fr', name: 'Français', google: 'fr' },
    { code: 'de', name: 'Deutsch', google: 'de' },
    { code: 'es', name: 'Español', google: 'es' },
    { code: 'ru', name: 'Русский', google: 'ru' },
    { code: 'pt', name: 'Português', google: 'pt' },
  ];

  function findLang(code) {
    return LANGS.find((l) => l.code === code) || LANGS[0];
  }

  // batch: { lines:[{id,text}], before:[], after:[] }
  // ctx: { glossary, title, lang }
  // deps: { llm(messages) -> Promise<string>, google(texts, tl) -> Promise<string[]> }
  async function translateBatch(batch, ctx, deps) {
    const ids = batch.lines.map((l) => l.id);
    const messages = C.buildTranslateMessages({
      lines: batch.lines, before: batch.before, after: batch.after,
      glossary: ctx.glossary || [], title: ctx.title, targetLangName: ctx.lang.name,
    });
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await deps.llm(messages);
        return { map: C.parseLlmResponse(content, ids), source: 'llm' };
      } catch (e) {
        lastErr = e;
      }
    }
    try {
      const out = await deps.google(batch.lines.map((l) => l.text), ctx.lang.google);
      if (!Array.isArray(out) || out.length !== ids.length) throw new Error('谷歌返回行数不符');
      return { map: new Map(ids.map((id, i) => [id, out[i]])), source: 'google', llmError: String(lastErr && lastErr.message) };
    } catch (e) {
      throw new Error(`大模型失败（${lastErr && lastErr.message}），谷歌也失败（${e.message}）`);
    }
  }

  const api = { translateBatch, LANGS, findLang };
  root.CRBS = Object.assign(root.CRBS || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
