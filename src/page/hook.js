// 运行在页面主世界：改写播放信息（硬字幕流 → 干净流），并识别播放器选中的字幕语言。
(function () {
  const C = window.CRBS;
  if (!C || window.__crbsHooked) return;
  window.__crbsHooked = true;

  const PLAY_RE = /\/playback\/v\d+\/[^/?#]+\/web\/[^/?#]+\/play/;
  const TAG_OUT = 'crbs-page';
  const TAG_IN = 'crbs-content';

  let enabled = true;
  let requestSerial = 0;
  let acceptedSerial = 0;
  let activeEpisode = null;
  let subtitleUrls = new Map();
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
    if (!enabled) return;
    const lang = C.parseManifestMarker(url) || subtitleUrls.get(url);
    if (!lang) return;
    // A manifest's ID identifies a stream, not an episode.
    post('subtitle-selected', { lang, episodeId: activeEpisode });
  }

  function processPlayback(json, url, serial) {
    // Old responses must not acquire fresh selection markers for another episode.
    if (serial < acceptedSerial) return json;
    const result = C.rewritePlayback(json);
    const episodeId = C.episodeIdFromPlayUrl(url);
    if (Object.keys(result.info.subtitles).length) {
      acceptedSerial = serial;
      activeEpisode = episodeId;
      subtitleUrls = new Map();
      function addSelectionUrl(url, lang) {
        if (!url || !lang) return;
        // A reused URL does not identify a language; never let the last track win.
        if (subtitleUrls.has(url) && subtitleUrls.get(url) !== lang) subtitleUrls.set(url, null);
        else subtitleUrls.set(url, lang);
      }
      for (const [lang, sub] of Object.entries(result.info.subtitles)) addSelectionUrl(sub.url, lang);
      // Hybrid none stays unmarked so the original no-subtitle selection URL is preserved.
      if (!/^(ad|promo|recap|preview|logo)$/i.test(json.type || '') && json.hardSubs && json.hardSubs.none) addSelectionUrl(json.hardSubs.none.url, 'none');
      // Keep every main element's selection URLs, including the rewritten markers.
      for (const el of json.stitchedElements || []) {
        if (!/^main/i.test(el.type || '')) continue;
        for (const track of el.textTracks || []) {
          const rawLang = track.language || track.locale;
          const lang = /^none$/i.test(rawLang || '') ? 'none' : rawLang;
          if (String(track.format).toUpperCase() === 'EXTERNAL') addSelectionUrl(track.externalTextUrl, lang);
          if (String(track.format).toUpperCase() === 'BURNED_IN' || lang === 'none') addSelectionUrl(track.videoUrl, lang);
        }
      }
    }
    post('playback', { episodeId, info: result.info, title: document.title });
    return result.json;
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    noteManifestSafe(url);
    const serial = PLAY_RE.test(url) ? ++requestSerial : 0;
    const res = await origFetch.apply(this, arguments);
    if (!PLAY_RE.test(url) || !res.ok) return res;
    try {
      await configReady;
      if (!enabled) return res;
      const json = await res.clone().json();
      const out = processPlayback(json, url, serial);
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
    const serial = PLAY_RE.test(String(url)) ? ++requestSerial : 0;
    // Install before the player's load handlers; JSON and text XHRs both occur.
    if (this.__crbsListener) this.removeEventListener('readystatechange', this.__crbsListener);
    this.__crbsListener = () => {
      if (!serial || this.readyState !== 4 || this.status < 200 || this.status >= 300 || !enabled) return;
      try {
        if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
        const json = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
        const out = processPlayback(json, String(url), serial);
        const text = JSON.stringify(out);
        Object.defineProperty(this, 'responseText', { configurable: true, get: () => text });
        Object.defineProperty(this, 'response', { configurable: true, get: () => this.responseType === 'json' ? out : text });
      } catch (err) {
        console.warn('[CRBS] 改写 XHR 播放信息失败，保持原样', err);
      }
    };
    // Reusing an XHR must expose its next native response rather than our old getters.
    delete this.responseText;
    delete this.response;
    this.addEventListener('readystatechange', this.__crbsListener);
    return origOpen.apply(this, arguments);
  };
})();
