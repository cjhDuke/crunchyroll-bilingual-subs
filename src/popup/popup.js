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

  async function refresh() {
    if (!onCr) {
      $('status').textContent = '当前页不是 Crunchyroll 播放页';
      return;
    }
    const res = await send({ type: 'getStatus' });
    if (!res || !res.ok) {
      $('status').textContent = '插件未在此页运行，请刷新页面';
      return;
    }
    const d = res.data;
    $('status').textContent = d.enabled ? (STATUS_TEXT[d.status] || d.status) : STATUS_TEXT.off;
    const s = d.stats;
    const lines = [];
    if (d.title) lines.push(d.title + (d.lang ? `（字幕 ${d.lang}）` : ''));
    if (s) {
      $('progress').hidden = false;
      $('bar').style.width = (s.total ? (100 * s.done) / s.total : 0) + '%';
      lines.push(`已翻译 ${s.done}/${s.total} 句` + (s.running ? `，进行中 ${s.running} 批` : ''));
      if (s.google) lines.push(`其中 ${s.google} 句由谷歌机翻兜底`);
      if (s.failedBatches) lines.push(`${s.failedBatches} 批翻译失败（显示原文）：${s.lastError || ''}`);
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
