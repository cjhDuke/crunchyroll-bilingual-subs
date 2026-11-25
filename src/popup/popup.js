(async function () {
  const C = globalThis.CRBS;
  const $ = (id) => document.getElementById(id);
  const STATUS_TEXT = {
    idle: '等待播放（未选择字幕或尚未开始播放）',
    loading: '正在加载字幕…',
    active: '双语字幕运行中',
    unsupported: '当前字幕格式不支持',
    error: '出错了',
    off: '已关闭',
  };

  const settings = await C.loadSettings();
  $('enabled').checked = settings.enabled;
  $('model').textContent = settings.apiKey ? settings.model : '未设置 API Key';

  $('displayMode').value = settings.displayMode;
  $('displayMode').addEventListener('change', () => C.saveSettings({ displayMode: $('displayMode').value }));
  $('enabled').addEventListener('change', () => C.saveSettings({ enabled: $('enabled').checked }));
  $('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onCr = tab && /^https:\/\/www\.crunchyroll\.com\//.test(tab.url || '');

  async function send(msg) {
    try { return await chrome.tabs.sendMessage(tab.id, msg); } catch { return null; }
  }

  let offsetEpisode = null;
  let offsetValue = 0;
  let editingOffset = false;
  let offsetVersion = 0;
  let pendingOffset = null;
  let sendingOffset = false;
  let refreshRequest = 0;

  function showOffset(value) {
    offsetValue = C.normalizeSubtitleOffset(value);
    $('offsetSeconds').value = offsetValue;
    $('offsetSlider').value = offsetValue;
  }

  function updateOffsetStatus(d, version) {
    const episodeId = d && d.episodeId || null;
    $('offsetControls').disabled = !onCr || !episodeId;
    if (offsetEpisode !== episodeId) {
      offsetEpisode = episodeId;
      pendingOffset = null;
      ++offsetVersion;
      editingOffset = false;
      showOffset(d ? d.subtitleOffsetSeconds : 0);
      $('offsetFeedback').textContent = '';
    } else if (!editingOffset && !sendingOffset && !pendingOffset && version === offsetVersion) {
      showOffset(d ? d.subtitleOffsetSeconds : 0);
    }
  }

  async function drainOffsets() {
    if (sendingOffset) return;
    sendingOffset = true;
    while (pendingOffset) {
      const next = pendingOffset;
      pendingOffset = null;
      const res = await send({ type: 'setSubtitleOffset', episodeId: next.episodeId, offsetSeconds: next.value });
      if (next.version !== offsetVersion || next.episodeId !== offsetEpisode) continue;
      $('offsetFeedback').textContent = res && res.ok ? '已保存到本集' : (res && res.error || '保存失败，请重试或刷新页面');
    }
    sendingOffset = false;
  }

  function changeOffset(value) {
    if (!offsetEpisode || $('offsetControls').disabled || value === '' || !Number.isFinite(Number(value))) return;
    showOffset(value);
    pendingOffset = { episodeId: offsetEpisode, value: offsetValue, version: ++offsetVersion };
    $('offsetFeedback').textContent = '正在保存…';
    drainOffsets();
  }

  for (const id of ['offsetSeconds', 'offsetSlider']) {
    $(id).addEventListener('focus', () => { editingOffset = true; });
    $(id).addEventListener('pointerdown', () => { editingOffset = true; });
    $(id).addEventListener('blur', () => { editingOffset = false; showOffset(offsetValue); });
  }
  $('offsetSeconds').addEventListener('input', () => { editingOffset = true; });
  $('offsetSeconds').addEventListener('change', () => changeOffset($('offsetSeconds').value));
  $('offsetSlider').addEventListener('input', () => changeOffset($('offsetSlider').value));
  $('offsetEarlier').addEventListener('click', () => changeOffset(offsetValue - C.SUBTITLE_OFFSET_STEP));
  $('offsetLater').addEventListener('click', () => changeOffset(offsetValue + C.SUBTITLE_OFFSET_STEP));
  $('offsetReset').addEventListener('click', () => changeOffset(0));

  async function refresh() {
    const request = ++refreshRequest;
    if (!onCr) {
      updateOffsetStatus(null, offsetVersion);
      $('status').textContent = '当前页不是 Crunchyroll 播放页';
      return;
    }
    const version = offsetVersion;
    const res = await send({ type: 'getStatus' });
    if (request !== refreshRequest) return;
    if (!res || !res.ok) {
      updateOffsetStatus(null, version);
      $('status').textContent = '插件未在此页运行，请刷新页面';
      return;
    }
    const d = res.data;
    updateOffsetStatus(d, version);
    $('status').textContent = d.enabled ? (STATUS_TEXT[d.status] || d.status) : STATUS_TEXT.off;
    const s = d.stats;
    const lines = [];
    if (d.title) lines.push(d.title + (d.lang ? `（字幕 ${d.lang}）` : ''));
    if (s) {
      $('progress').hidden = false;
      $('bar').style.width = (s.total ? (100 * s.done) / s.total : 0) + '%';
      lines.push(`已翻译 ${s.done}/${s.total} 句` + (s.running ? `，进行中 ${s.running} 批` : ''));
      if (s.google) lines.push(`其中 ${s.google} 句由谷歌机翻兜底`);
      if (s.failedBatches) lines.push(`${s.failedBatches} 批翻译失败：${s.lastError || ''}`);
    } else {
      $('progress').hidden = true;
    }
    if (d.error) lines.push(d.error);
    $('detail').textContent = lines.join('\n');
    $('detail').style.whiteSpace = 'pre-line';
    $('retryGoogle').disabled = !s || (!s.google && !s.failedBatches);
    $('retryAll').disabled = !s;
  }

  $('retryGoogle').addEventListener('click', async () => { await send({ type: 'retranslate', scope: 'google' }); refresh(); });
  $('retryAll').addEventListener('click', async () => {
    if (!confirm('全部重新翻译会再次调用 API，确定吗？')) return;
    await send({ type: 'retranslate', scope: 'all' });
    refresh();
  });

  refresh();
  setInterval(refresh, 1000);
})();
