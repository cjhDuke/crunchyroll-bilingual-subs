// 内容脚本：接收页面钩子的消息，下载字幕、组织翻译、控制开播等待与显示。
(function () {
  const C = globalThis.CRBS;
  const TAG_IN = 'crbs-page';
  const TAG_OUT = 'crbs-content';
  const START_WAIT_MS = 25000;

  let settings = Object.assign({}, C.DEFAULT_SETTINGS);
  const state = {
    episodeId: null,
    title: '',
    subtitles: {},
    pendingLang: null,
    trackKey: null,
    lang: null,
    session: null,
    status: 'idle', // idle | loading | active | unsupported | error | off
    error: null,
  };
  let gate = null;
  let lastPlayheadPush = 0;

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
    return { displayMode: settings.displayMode, translationPosition: settings.translationPosition, fontScale: settings.fontScale };
  }

  // ---------- 会话 ----------

  function stopSession() {
    endGate(false, true);
    if (state.session) state.session.stop();
    state.session = null;
    state.trackKey = null;
    state.lang = null;
    overlay.clear();
  }

  async function selectTrack(lang, episodeId) {
    if (!settings.enabled) return;
    if (episodeId && state.episodeId && episodeId !== state.episodeId) {
      // 播放信息还没到（或属于别的集），先记下
      state.pendingLang = { lang, episodeId };
      return;
    }
    const key = `${state.episodeId}:${lang}`;
    if (key === state.trackKey) return;
    stopSession();
    state.trackKey = key;
    state.lang = lang;
    if (lang === 'none') { state.status = 'idle'; return; }
    const sub = state.subtitles[lang];
    if (!sub) {
      state.pendingLang = { lang, episodeId };
      state.trackKey = null;
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
      if (state.trackKey !== key) return;
      const { events } = C.parseAss(text);
      const dialogue = events.filter(C.isDialogueEvent);
      const dialogueSet = new Set(dialogue.map((e) => e.index));
      overlay.setOptions(overlayOpts());
      overlay.setTrack({ dialogue, signsAss: C.stripDialogue(text, dialogueSet) });

      const lang2 = C.findLang(settings.targetLang);
      const cacheKey = `cache:${state.episodeId}:${lang}:${lang2.code}:${C.hashString(text)}`;
      const session = new C.TrackSession({
        events: dialogue,
        title: state.title,
        settings,
        deps: {
          translateBatch: (input, ctx) => C.translateBatch(input, Object.assign({}, ctx, { lang: lang2 }), {
            llm: (messages) => bg({ type: 'chat', messages }),
            google: (texts, tl) => bg({ type: 'google', texts, tl }),
          }),
          glossary: async (allText) => {
            const content = await bg({ type: 'chat', messages: C.buildGlossaryMessages({ allText, title: state.title, targetLangName: lang2.name }) });
            return C.parseGlossary(content);
          },
          cacheGet: async () => (await chrome.storage.local.get(cacheKey))[cacheKey] || null,
          cacheSet: (obj) => chrome.storage.local.set({ [cacheKey]: Object.assign(obj, { episodeId: state.episodeId, subLang: lang, targetLang: lang2.code }) }),
        },
      });
      state.session = session;
      overlay.setSession(session);
      session.onUpdate(() => checkGate());
      const v = C.findVideo();
      if (v) session.setPlayhead(v.currentTime);
      gate && (gate.session = session);
      await session.start();
      state.status = 'active';
      checkGate();
    } catch (err) {
      if (state.trackKey !== key) return;
      state.status = 'error';
      state.error = String((err && err.message) || err);
      endGate(false);
      overlay.toast('字幕加载失败：' + state.error, 5000);
    }
  }

  // ---------- 开播等待：未就绪时暂停，就绪后自动播放 ----------

  function beginGate(session) {
    endGate(false, true);
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
    return gate.session.isReadyAt(v ? v.currentTime : 0);
  }

  function checkGate() {
    if (!gate) return;
    if (isReadyNow()) {
      endGate(true);
    } else if (Date.now() > gate.deadline) {
      endGate(true);
      overlay.toast('翻译较慢，先显示原字幕，译文稍后出现', 4000);
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
    if (state.session && e.target instanceof HTMLVideoElement) state.session.setPlayhead(e.target.currentTime);
  }, true);

  document.addEventListener('timeupdate', (e) => {
    if (!state.session || !(e.target instanceof HTMLVideoElement)) return;
    const now = Date.now();
    if (now - lastPlayheadPush > 3000) {
      lastPlayheadPush = now;
      state.session.setPlayhead(e.target.currentTime);
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
      if (msg.episodeId !== state.episodeId) stopSession();
      state.episodeId = msg.episodeId;
      state.title = cleanTitle(msg.title);
      state.subtitles = (msg.info && msg.info.subtitles) || {};
      const p = state.pendingLang;
      if (p && (!p.episodeId || p.episodeId === state.episodeId)) {
        state.pendingLang = null;
        selectTrack(p.lang, p.episodeId);
      }
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
          title: state.title,
          lang: state.lang,
          status: state.status,
          error: state.error,
          stats: state.session ? state.session.stats() : null,
        },
      });
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
