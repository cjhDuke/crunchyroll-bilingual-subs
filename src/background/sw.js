// 后台：只负责跨域网络请求（字幕下载、大模型、谷歌翻译）。
importScripts('../shared/settings.js', '../core/llm.js', '../core/google.js', '../core/translator.js');

const C = self.CRBS;

async function handle(msg) {
  switch (msg && msg.type) {
    case 'fetchText': {
      const res = await fetch(msg.url);
      if (!res.ok) throw new Error(`下载字幕失败：HTTP ${res.status}`);
      return await res.text();
    }
    case 'chat': {
      const s = await C.loadSettings();
      if (!s.apiKey) throw new Error('未设置 API Key');
      return await C.chatCompletion(s, msg.messages, { timeoutMs: s.timeoutMs });
    }
    case 'google':
      return await C.googleTranslateLines(msg.texts, msg.tl);
    case 'testConnection': {
      const s = Object.assign(await C.loadSettings(), msg.override || {});
      const lang = C.findLang(s.targetLang);
      const messages = C.buildTranslateMessages({
        lines: [{ id: 1, text: "I'll become the Wizard King!" }], targetLangName: lang.name,
      });
      const t0 = Date.now();
      const content = await C.chatCompletion(s, messages, { timeoutMs: s.timeoutMs });
      const map = C.parseLlmResponse(content, [1]);
      return { text: map.get(1), ms: Date.now() - t0 };
    }
    case 'openOptions':
      await chrome.runtime.openOptionsPage();
      return true;
    default:
      throw new Error('未知消息类型：' + (msg && msg.type));
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
  );
  return true;
});
