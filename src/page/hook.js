// 运行在页面主世界：改写播放信息（硬字幕流 → 干净流），并识别播放器选中的字幕语言。
(function () {
  const C = window.CRBS;
  if (!C || window.__crbsHooked) return;
  window.__crbsHooked = true;

  const PLAY_RE = /\/playback\/v\d+\/[^/?#]+\/web\/[^/?#]+\/play/;
  const MANIFEST_EP_RE = /\/manifest\/([^/?#]+)\//;
  const TAG_OUT = 'crbs-page';
  const TAG_IN = 'crbs-content';

  let enabled = true;
  let resolveConfig;
  const configReady = new Promise((r) => { resolveConfig = r; });
  setTimeout(() => resolveConfig(), 1500); // 内容脚本没回应时按启用处理

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== TAG_IN) return;
    if (e.data.type === 'config') {
      enabled = !!e.data.enabled;
      resolveConfig();
    }
  });

  function post(type, payload) {
    window.postMessage(Object.assign({ source: TAG_OUT, type }, payload), '*');
  }
  post('need-config', {});

  function noteManifest(url) {
    const lang = C.parseManifestMarker(url);
    if (!lang) return;
    const m = MANIFEST_EP_RE.exec(url);
    post('subtitle-selected', { lang, episodeId: m ? m[1] : null });
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    noteManifestSafe(url);
    const res = await origFetch.apply(this, arguments);
    if (!PLAY_RE.test(url) || !res.ok) return res;
    try {
      await configReady;
      if (!enabled) return res;
      const json = await res.clone().json();
      const { json: out, info } = C.rewritePlayback(json);
      post('playback', { episodeId: C.episodeIdFromPlayUrl(url), info, title: document.title });
      const headers = new Headers(res.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(JSON.stringify(out), { status: res.status, statusText: res.statusText, headers });
    } catch (err) {
      console.warn('[CRBS] 改写播放信息失败，保持原样', err);
      return res;
    }
  };

  function noteManifestSafe(url) {
    try { noteManifest(String(url)); } catch { /* ignore */ }
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    noteManifestSafe(url);
    return origOpen.apply(this, arguments);
  };
})();
