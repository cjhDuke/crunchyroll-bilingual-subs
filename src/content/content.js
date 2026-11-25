// 内容脚本：接收页面钩子的消息，下载字幕、组织翻译、控制开播等待与显示。
(function () {
  const C = globalThis.CRBS;
  const TAG_IN = 'crbs-page';
  const TAG_OUT = 'crbs-content';
  const START_WAIT_MS = 25000;

  let settings = Object.assign({}, C.DEFAULT_SETTINGS);
  const state = {
    episodeId: null,
    subtitleOffsetSeconds: 0,
    title: '',
    subtitles: {},
    pendingLang: null,
    desiredLang: null,
    hasAds: false,
    trackKey: null,
    lang: null,
    session: null,
    status: 'idle', // idle | loading | active | unsupported | error | off
    error: null,
  };
  let gate = null;
  let lastPlayheadPush = 0;
  let generation = 0;
  let selectionTimer = null;
  let adEpisode = null;
  let offsetRevision = 0;
  let offsetWrites = Promise.resolve();

  const overlay = new C.Overlay();

  function postToPage(type, payload) {
    window.postMessage(Object.assign({ source: TAG_OUT, type }, payload), '*');
  }

  function postConfig() {
    postToPage('config', { enabled: !!settings.enabled });
  }

  async function bg(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res) throw new Error('后台无响应');
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  function cleanTitle(t) {
    const parts = String(t || '').split(' - ');
    if (parts.length > 1 && /crunchyroll/i.test(parts[parts.length - 1])) parts.pop();
    return parts.join(' - ').trim();
  }

  function overlayOpts() {
    return { displayMode: settings.displayMode, translationPosition: settings.translationPosition, fontScale: settings.fontScale, subtitleOffsetSeconds: state.subtitleOffsetSeconds };
  }

  function subtitleTime(video) {
    return (video ? video.currentTime : 0) - state.subtitleOffsetSeconds;
  }

  function applyOffset(offset) {
    state.subtitleOffsetSeconds = C.normalizeSubtitleOffset(offset);
    overlay.setOptions(overlayOpts());
    if (state.session) state.session.setPlayhead(subtitleTime(C.findVideo()));
    checkGate();
  }

  async function loadOffset(episodeId) {
    const revision = ++offsetRevision;
    applyOffset(0);
    try {
      await offsetWrites;
      const key = C.subtitleOffsetKey(episodeId);
      const saved = await chrome.storage.local.get(key);
      if (revision === offsetRevision && episodeId === state.episodeId) applyOffset(saved[key]);
    } catch { /* 存储不可用时保留本次播放值 */ }
  }

  // ---------- 会话 ----------

  function stopSession() {
    generation++;
    endGate(true, true);
    if (state.session) state.session.stop();
    state.session = null;
    state.trackKey = null;
    state.lang = null;
    overlay.clear();
  }

  async function selectTrack(lang, episodeId) {
    if (!settings.enabled) return;
    if (!state.episodeId || (episodeId && episodeId !== state.episodeId)) {
      // 播放信息还没到（或属于别的集），先记下
      state.pendingLang = { lang, episodeId };
      return;
    }
    state.desiredLang = lang;
    clearTimeout(selectionTimer);
    selectionTimer = null;
    const sub = state.subtitles[lang];
    const key = `${state.episodeId}:${lang}:${sub ? sub.format : ''}`;
    if (key === state.trackKey && state.status !== 'error') return;
    stopSession();
    const token = generation;
    const current = () => token === generation;
    const selectedEpisode = state.episodeId;
    const title = state.title;
    const selectedSettings = settings;
    state.trackKey = key;
    state.lang = lang;
    state.error = null;
    if (lang === 'none') { state.status = 'idle'; return; }
    if (!sub) {
      state.trackKey = null;
      state.status = 'idle';
      return;
    }
    if (sub.format !== 'ass') {
      state.status = 'unsupported';
      overlay.toast('此字幕格式暂不支持（' + (sub.format || '未知') + '）', 4000);
      return;
    }
    state.status = 'loading';
    state.error = null;
    try {
      // 在下载字幕期间就先拦住开播
      beginGate(null);
      const text = await bg({ type: 'fetchText', url: sub.url });
      if (!current()) return;
      const { events } = C.parseAss(text);
      const dialogue = events.filter(C.isDialogueEvent);
      const dialogueSet = new Set(dialogue.map((e) => e.index));
      overlay.setOptions(overlayOpts());
      overlay.setTrack({ dialogue, signsAss: C.stripDialogue(text, dialogueSet) });

      const lang2 = C.findLang(selectedSettings.targetLang);
      const cacheKey = `cache:${selectedEpisode}:${lang}:${lang2.code}:${C.hashString(text)}`;
      const session = new C.TrackSession({
        events: dialogue,
        title,
        settings: selectedSettings,
        deps: {
          translateBatch: (input, ctx) => C.translateBatch(input, Object.assign({}, ctx, { lang: lang2 }), {
            llm: (messages) => bg({ type: 'chat', messages }),
            google: (texts, tl) => bg({ type: 'google', texts, tl }),
          }),
          glossary: async (allText) => {
            const content = await bg({ type: 'chat', messages: C.buildGlossaryMessages({ allText, title, targetLangName: lang2.name }) });
            return C.parseGlossary(content);
          },
          cacheGet: async () => (await chrome.storage.local.get(cacheKey))[cacheKey] || null,
          cacheSet: (obj) => chrome.storage.local.set({ [cacheKey]: Object.assign({}, obj, { episodeId: selectedEpisode, subLang: lang, targetLang: lang2.code }) }),
        },
      });
      state.session = session;
      overlay.setSession(session);
      session.onUpdate(() => checkGate());
      const v = C.findVideo();
      if (v) session.setPlayhead(subtitleTime(v));
      gate && (gate.session = session);
      await session.start();
      if (!current()) return;
      state.status = 'active';
      checkGate();
    } catch (err) {
      if (!current()) return;
      state.status = 'error';
      state.error = String((err && err.message) || err);
      endGate(true);
      overlay.toast('字幕加载失败：' + state.error, 5000);
    }
  }

  function ensureSelection() {
    if (state.desiredLang !== null) {
      selectTrack(state.desiredLang, state.episodeId);
    } else {
      if (selectionTimer !== null) return;
      selectionTimer = setTimeout(() => {
        selectionTimer = null;
        const langs = Object.keys(state.subtitles);
        const lang = langs.find((l) => /^en(?:-|$)/i.test(l) && state.subtitles[l].format === 'ass')
          || langs.find((l) => state.subtitles[l].format === 'ass') || langs[0];
        if (lang) selectTrack(lang, state.episodeId);
      }, 2500);
    }
  }

  // ---------- 开播等待：未就绪时暂停，就绪后自动播放 ----------

  function beginGate(session) {
    endGate(false, true);
    if (state.hasAds) return;
    gate = { session, deadline: Date.now() + START_WAIT_MS, pausedByUs: false, timer: null };
    gate.timer = setInterval(checkGate, 500);
    const v = C.findVideo();
    if (v && !v.paused) holdVideo(v);
  }

  function holdVideo(v) {
    if (!gate) return;
    gate.pausedByUs = true;
    v.pause();
    overlay.toast('正在翻译字幕…', 0);
  }

  function isReadyNow() {
    if (!gate || !gate.session) return false;
    const v = C.findVideo();
    return gate.session.isReadyAt(subtitleTime(v));
  }

  function checkGate() {
    if (!gate) return;
    if (isReadyNow()) {
      endGate(true);
    } else if (Date.now() > gate.deadline) {
      endGate(true);
      overlay.toast('翻译较慢，先继续播放，译文稍后出现', 4000);
    }
  }

  function endGate(resume, silent) {
    if (!gate) return;
    clearInterval(gate.timer);
    const wasPaused = gate.pausedByUs;
    gate = null;
    if (!silent) overlay.hideToast();
    if (resume && wasPaused) {
      const v = C.findVideo();
      if (v && v.paused) v.play().catch(() => {});
    }
  }

  document.addEventListener('play', (e) => {
    if (!gate || !(e.target instanceof HTMLVideoElement)) return;
    if (!isReadyNow()) holdVideo(e.target);
  }, true);

  document.addEventListener('seeking', (e) => {
    if (state.session && e.target instanceof HTMLVideoElement) state.session.setPlayhead(subtitleTime(e.target));
  }, true);

  document.addEventListener('timeupdate', (e) => {
    if (!state.session || !(e.target instanceof HTMLVideoElement)) return;
    const now = Date.now();
    if (now - lastPlayheadPush > 3000) {
      lastPlayheadPush = now;
      state.session.setPlayhead(subtitleTime(e.target));
    }
  }, true);

  // ---------- 与页面钩子通信 ----------

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== TAG_IN) return;
    const msg = e.data;
    if (msg.type === 'need-config') {
      postConfig();
    } else if (msg.type === 'playback') {
      if (!settings.enabled) return;
      const subtitles = (msg.info && msg.info.subtitles) || {};
      // An ad/promo response is not a new episode or a replacement track list.
      if (!Object.keys(subtitles).length) {
        if (msg.info && msg.info.hasAds) {
          adEpisode = msg.episodeId;
          if (msg.episodeId === state.episodeId) {
            state.hasAds = true;
            endGate(true);
          }
        }
        return;
      }
      if (msg.episodeId !== state.episodeId) {
        stopSession();
        clearTimeout(selectionTimer);
        selectionTimer = null;
        state.desiredLang = null;
        state.hasAds = msg.episodeId === adEpisode;
        state.episodeId = msg.episodeId;
        loadOffset(msg.episodeId);
      }
      state.episodeId = msg.episodeId;
      state.title = cleanTitle(msg.title);
      state.subtitles = subtitles;
      state.hasAds = state.hasAds || !!msg.info.hasAds;
      if (state.hasAds) endGate(true);
      const p = state.pendingLang;
      if (p && (!p.episodeId || p.episodeId === state.episodeId)) {
        state.pendingLang = null;
        selectTrack(p.lang, p.episodeId);
      } else ensureSelection();
    } else if (msg.type === 'subtitle-selected') {
      selectTrack(msg.lang, msg.episodeId);
    }
  });

  // ---------- 弹窗消息 ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'getStatus') {
      sendResponse({
        ok: true,
        data: {
          enabled: settings.enabled,
          episodeId: state.episodeId,
          subtitleOffsetSeconds: state.subtitleOffsetSeconds,
          title: state.title,
          lang: state.lang,
          status: state.status,
          error: state.error,
          stats: state.session ? state.session.stats() : null,
        },
      });
    } else if (msg.type === 'setSubtitleOffset') {
      if (!state.episodeId || msg.episodeId !== state.episodeId || typeof msg.offsetSeconds !== 'number' || !Number.isFinite(msg.offsetSeconds)) {
        sendResponse({ ok: false, error: '播放集已变化或偏移值无效，请重新打开弹窗' });
        return false;
      }
      ++offsetRevision; // 用户调整优先于尚未结束的本集读取。
      const episodeId = state.episodeId;
      const offset = C.normalizeSubtitleOffset(msg.offsetSeconds);
      applyOffset(offset);
      const write = offsetWrites.then(() => chrome.storage.local.set({ [C.subtitleOffsetKey(episodeId)]: offset }));
      offsetWrites = write.catch(() => {});
      write.then(() => sendResponse({ ok: true, data: { episodeId, subtitleOffsetSeconds: offset } }),
        () => sendResponse({ ok: false, error: '时间调整已生效，但保存失败，请重试' }));
      return true;
    } else if (msg.type === 'retranslate') {
      if (state.session) state.session.retranslate(msg.scope === 'all' ? 'all' : 'google');
      sendResponse({ ok: !!state.session });
    }
    return false;
  });

  // ---------- 设置 ----------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[C.SETTINGS_KEY]) return;
    const prevEnabled = settings.enabled;
    settings = Object.assign({}, C.DEFAULT_SETTINGS, changes[C.SETTINGS_KEY].newValue || {});
    postConfig();
    overlay.setOptions(overlayOpts());
    if (prevEnabled && !settings.enabled) {
      stopSession();
      state.status = 'off';
      overlay.toast('双语字幕已关闭，刷新页面恢复原字幕', 4000);
    } else if (!prevEnabled && settings.enabled) {
      overlay.toast('双语字幕已开启，刷新页面后生效', 4000);
    }
  });

  C.loadSettings().then((s) => {
    settings = s;
    if (!settings.enabled) state.status = 'off';
    overlay.setOptions(overlayOpts());
    postConfig();
  });
})();
