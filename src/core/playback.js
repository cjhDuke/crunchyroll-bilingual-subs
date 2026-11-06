// Crunchyroll 播放信息处理：把硬字幕流换成干净流，并打上字幕语言标记。
// 该文件同时在页面主世界（hook.js 之前）和隔离世界加载。
(function (root) {
  const MARKER = 'crbs_sub';

  function withParam(url, key, value) {
    return url + (url.includes('?') ? '&' : '?') + key + '=' + encodeURIComponent(value);
  }

  function rewritePlayback(json, marker = MARKER) {
    const info = { subtitles: {} };
    if (!json || typeof json !== 'object') return { json, info };
    for (const [lang, sub] of Object.entries(json.subtitles || {})) {
      if (lang === 'none' || !sub || !sub.url) continue;
      info.subtitles[lang] = { format: String(sub.format || '').toLowerCase(), url: sub.url };
    }
    if (json.url && json.hardSubs && typeof json.hardSubs === 'object') {
      for (const [lang, hs] of Object.entries(json.hardSubs)) {
        if (hs && typeof hs === 'object') hs.url = withParam(json.url, marker, lang);
      }
    }
    return { json, info };
  }

  function episodeIdFromPlayUrl(url) {
    const m = /\/playback\/v\d+\/([^/?#]+)\/web\//.exec(url);
    return m ? m[1] : null;
  }

  function parseManifestMarker(url, marker = MARKER) {
    const m = new RegExp('[?&]' + marker + '=([^&#]+)').exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  }

  const api = { rewritePlayback, episodeIdFromPlayUrl, parseManifestMarker, MARKER };
  root.CRBS = Object.assign(root.CRBS || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
