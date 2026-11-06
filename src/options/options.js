(async function () {
  const C = globalThis.CRBS;
  const $ = (id) => document.getElementById(id);
  const fields = ['provider', 'baseUrl', 'apiKey', 'model', 'extraParams', 'targetLang', 'displayMode', 'translationPosition', 'fontScale', 'batchSize', 'concurrency', 'timeoutMs'];

  for (const [id, p] of Object.entries(C.PROVIDER_PRESETS)) $('provider').add(new Option(p.label, id));
  for (const l of C.LANGS) $('targetLang').add(new Option(l.name, l.code));

  function fill(s) {
    for (const f of fields) $(f).value = s[f];
    $('fontScaleOut').textContent = '×' + Number(s.fontScale).toFixed(2);
  }

  function read() {
    const out = {};
    for (const f of fields) out[f] = $(f).value.trim();
    out.fontScale = Number(out.fontScale);
    out.batchSize = clampInt(out.batchSize, 5, 100, 30);
    out.concurrency = clampInt(out.concurrency, 1, 16, 5);
    out.timeoutMs = clampInt(out.timeoutMs, 5000, 120000, 30000);
    out.baseUrl = out.baseUrl.replace(/\/+$/, '');
    return out;
  }

  function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  }

  function setHint(el, text, cls) {
    el.textContent = text;
    el.className = 'hint' + (cls ? ' ' + cls : '');
  }

  // 自定义 Base URL 需要临时申请该域名的访问权限（必须在点击事件里调用）
  async function ensureOrigin(baseUrl) {
    let origin;
    try { origin = new URL(baseUrl).origin + '/*'; } catch { throw new Error('Base URL 格式不正确'); }
    // 已授权时直接返回 true，不会弹窗；先 await 其他调用可能丢失用户手势，所以直接 request
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error('未授予访问 ' + origin + ' 的权限');
  }

  function validate(s) {
    C.parseExtraParams(s.extraParams);
    if (!s.baseUrl) throw new Error('请填写 Base URL');
    if (!s.model) throw new Error('请填写模型名');
  }

  fill(await C.loadSettings());

  $('provider').addEventListener('change', () => {
    const p = C.PROVIDER_PRESETS[$('provider').value];
    if (p && $('provider').value !== 'custom') {
      $('baseUrl').value = p.baseUrl;
      $('model').value = p.model;
      $('extraParams').value = p.extraParams;
    }
  });

  $('fontScale').addEventListener('input', () => {
    $('fontScaleOut').textContent = '×' + Number($('fontScale').value).toFixed(2);
  });

  $('toggleKey').addEventListener('click', () => {
    const show = $('apiKey').type === 'password';
    $('apiKey').type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? '隐藏' : '显示';
  });

  $('save').addEventListener('click', async () => {
    const s = read();
    try {
      validate(s);
      await ensureOrigin(s.baseUrl);
      await C.saveSettings(s);
      setHint($('saveResult'), '已保存', 'ok');
    } catch (e) {
      setHint($('saveResult'), e.message, 'err');
    }
  });

  $('test').addEventListener('click', async () => {
    const s = read();
    setHint($('testResult'), '测试中…');
    try {
      validate(s);
      await ensureOrigin(s.baseUrl);
      const res = await chrome.runtime.sendMessage({ type: 'testConnection', override: s });
      if (!res || !res.ok) throw new Error(res ? res.error : '后台无响应');
      setHint($('testResult'), `成功（${res.data.ms} ms）：${res.data.text}`, 'ok');
    } catch (e) {
      setHint($('testResult'), '失败：' + e.message, 'err');
    }
  });

  async function refreshCache() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('cache:'));
    const bytes = keys.reduce((n, k) => n + JSON.stringify(all[k]).length, 0);
    setHint($('cacheInfo'), `已缓存 ${keys.length} 条字幕轨，约 ${(bytes / 1024).toFixed(1)} KB。`);
  }

  $('clearCache').addEventListener('click', async () => {
    if (!confirm('确定清空所有翻译缓存？清空后重看会重新调用 API。')) return;
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('cache:')));
    refreshCache();
  });

  refreshCache();
})();
