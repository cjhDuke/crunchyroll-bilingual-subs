// Crunchyroll 播放信息处理：把硬字幕流换成干净流，并打上字幕语言标记。
// 该文件同时在页面主世界（hook.js 之前）和隔离世界加载。
(function (root) {
  const MARKER = 'crbs_sub';

  function paramName(part) {
    try { return decodeURIComponent(part.split('=', 1)[0]); } catch { return null; }
  }

  function withParam(url, key, value) {
    const hash = url.indexOf('#');
    const head = hash < 0 ? url : url.slice(0, hash);
    const tail = hash < 0 ? '' : url.slice(hash);
    const query = head.indexOf('?');
    const param = encodeURIComponent(key) + '=' + encodeURIComponent(value);
    if (query < 0) return head + '?' + param + tail;
    let replaced = false;
    const parts = [];
    // Keep signed query bytes intact; replace only our own marker, including duplicates.
    for (const part of head.slice(query + 1).split('&')) {
      if (paramName(part) !== key) parts.push(part);
      else if (!replaced) { parts.push(param); replaced = true; }
    }
    if (!replaced) parts.push(param);
    return head.slice(0, query + 1) + parts.join('&') + tail;
  }

  function videoUrl(url) {
    if (typeof url !== 'string' || !url || url !== url.trim()) return false;
    try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
  }

  function trackLanguage(track) {
    const lang = track.language || track.locale;
    return /^none$/i.test(lang || '') ? 'none' : lang;
  }

  function rewritePlayback(json, marker = MARKER) {
    const info = { subtitles: {}, hasAds: false };
    if (!json || typeof json !== 'object') return { json, info };
    function addSubtitle(lang, sub) {
      if (!info.subtitles[lang] || info.subtitles[lang].format !== 'ass' || sub.format === 'ass') info.subtitles[lang] = sub;
    }
    const elements = Array.isArray(json.stitchedElements) ? json.stitchedElements : [];
    info.hasAds = !!json.hasAds || !!(json.ads && json.ads.adBreaks && json.ads.adBreaks.length)
      || /^ad$/i.test(json.type || '')
      || elements.some((el) => /^ad$/i.test(el.type || ''));
    const stitched = Array.isArray(json.stitchedElements);
    const legacyMain = !/^(ad|promo|recap|preview|logo)$/i.test(json.type || '');
    const hybrid = stitched && json.url && json.hardSubs && json.subtitles;
    for (const [lang, sub] of Object.entries(legacyMain ? json.subtitles || {} : {})) {
      if (lang === 'none' || !sub || !sub.url) continue;
      addSubtitle(lang, { format: String(sub.format || '').toLowerCase(), url: sub.url });
    }
    for (const el of elements) {
      if (!/^main/i.test(el.type || '')) continue;
      const tracks = el.textTracks || [];
      const assTracks = new Map();
      for (const track of tracks) {
        const lang = trackLanguage(track);
        if (!lang || lang === 'none') continue;
        if (String(track.format).toUpperCase() === 'EXTERNAL' && track.externalTextUrl) {
          const url = track.externalTextUrl;
          const ext = /\.(ass|vtt)(?:[?#]|$)/i.exec(url);
          const sub = { url, format: ext ? ext[1].toLowerCase() : String(track.fileFormat || '').toLowerCase() };
          addSubtitle(lang, sub);
          if (sub.format === 'ass') {
            if (!assTracks.has(lang)) assTracks.set(lang, []);
            assTracks.get(lang).push(track);
          }
        }
      }
      const noneUrls = new Set(tracks.filter((t) => trackLanguage(t) === 'none' && videoUrl(t.videoUrl)).map((t) => t.videoUrl));
      for (const track of tracks) {
        const lang = trackLanguage(track);
        if (String(track.format).toUpperCase() !== 'BURNED_IN' || !videoUrl(track.videoUrl) || !assTracks.has(lang)) continue;
        const ownUrls = new Set(assTracks.get(lang).filter((t) => videoUrl(t.videoUrl)).map((t) => t.videoUrl));
        const candidates = ownUrls.size ? ownUrls : noneUrls;
        // Neither the element's default videoUrl nor a different element proves a clean stream.
        if (candidates.size !== 1) continue;
        track.videoUrl = withParam(candidates.values().next().value, marker, lang);
      }
    }
    if (legacyMain && json.url && json.hardSubs && typeof json.hardSubs === 'object') {
      const clean = json.hardSubs.none && json.hardSubs.none.url;
      for (const [lang, hs] of Object.entries(json.hardSubs)) {
        if (!hs || typeof hs !== 'object') continue;
        if (!stitched) hs.url = withParam(json.url, marker, lang);
        else if (hybrid && lang !== 'none' && videoUrl(clean)) {
          const sub = json.subtitles[lang];
          if (sub && sub.url && String(sub.format).toLowerCase() === 'ass') hs.url = withParam(clean, marker, lang);
        }
      }
    }
    return { json, info };
  }

  function episodeIdFromPlayUrl(url) {
    const m = /\/playback\/v\d+\/([^/?#]+)\/web\//.exec(url);
    return m ? m[1] : null;
  }

  function parseManifestMarker(url, marker = MARKER) {
    const head = String(url).split('#', 1)[0];
    const query = head.indexOf('?');
    if (query < 0) return null;
    for (const part of head.slice(query + 1).split('&')) {
      if (paramName(part) !== marker || !part.includes('=')) continue;
      try { return decodeURIComponent(part.slice(part.indexOf('=') + 1)) || null; } catch { return null; }
    }
    return null;
  }

  const api = { rewritePlayback, episodeIdFromPlayUrl, parseManifestMarker, MARKER };
  root.CRBS = Object.assign(root.CRBS || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
