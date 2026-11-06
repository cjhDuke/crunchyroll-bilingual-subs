// 谷歌免费机翻（无需 Key 的公开接口），仅作兜底。
(function (root) {
  const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

  async function translateOne(text, tl, fetchImpl) {
    const url = `${ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`谷歌翻译 HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('谷歌翻译返回格式异常');
    return data[0].map((seg) => (Array.isArray(seg) ? seg[0] || '' : '')).join('');
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  async function googleTranslateLines(texts, tl, { fetchImpl = fetch } = {}) {
    const flat = texts.map((t) => String(t).replace(/\s*\n\s*/g, ' '));
    try {
      const joined = await translateOne(flat.join('\n'), tl, fetchImpl);
      const parts = joined.split('\n').map((s) => s.trim());
      if (parts.length === flat.length && parts.every((p) => p)) return parts;
    } catch (e) {
      if (flat.length === 1) throw e;
    }
    return mapLimit(flat, 4, async (t) => (await translateOne(t, tl, fetchImpl)).trim());
  }

  const api = { googleTranslateLines };
  root.CRBS = Object.assign(root.CRBS || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
