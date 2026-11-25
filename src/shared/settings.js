// 设置的默认值、供应商预设与读写。设置页、弹窗、后台、内容脚本共用。
(function (root) {
  const PROVIDER_PRESETS = {
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      extraParams: '{"thinking": {"type": "disabled"}}',
    },
    custom: {
      label: '自定义（OpenAI 兼容接口）',
      baseUrl: '',
      model: '',
      extraParams: '',
    },
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    provider: 'deepseek',
    baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
    apiKey: '',
    model: PROVIDER_PRESETS.deepseek.model,
    extraParams: PROVIDER_PRESETS.deepseek.extraParams,
    targetLang: 'zh-CN',
    displayMode: 'bilingual', // bilingual | translation | original
    translationPosition: 'top', // top | bottom
    fontScale: 1,
    batchSize: 30,
    concurrency: 5,
    timeoutMs: 30000,
  };

  const KEY = 'settings';
  const SUBTITLE_OFFSET_MAX = 600;
  const SUBTITLE_OFFSET_STEP = 0.5;

  function normalizeSubtitleOffset(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(Math.max(-SUBTITLE_OFFSET_MAX, Math.min(SUBTITLE_OFFSET_MAX, n)) / SUBTITLE_OFFSET_STEP) * SUBTITLE_OFFSET_STEP : 0;
  }

  function subtitleOffsetKey(episodeId) {
    return 'subtitleOffset:' + episodeId;
  }

  async function loadSettings() {
    const got = await chrome.storage.local.get(KEY);
    return Object.assign({}, DEFAULT_SETTINGS, got[KEY] || {});
  }

  async function saveSettings(partial) {
    const cur = await loadSettings();
    const next = Object.assign(cur, partial);
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  const api = { PROVIDER_PRESETS, DEFAULT_SETTINGS, SETTINGS_KEY: KEY, loadSettings, saveSettings,
    SUBTITLE_OFFSET_MAX, SUBTITLE_OFFSET_STEP, normalizeSubtitleOffset, subtitleOffsetKey };
  root.CRBS = Object.assign(root.CRBS || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
