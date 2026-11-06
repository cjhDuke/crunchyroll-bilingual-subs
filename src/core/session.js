// 一条字幕轨的翻译会话：切批、按播放位置排优先级、术语表、缓存、重翻。
(function (root) {
  const CONTEXT_LINES = 3;
  const LOOKAHEAD_SEC = 30;

  class TrackSession {
    constructor({ events, title = '', settings, deps, cacheDelayMs = 1000 }) {
      this.dialogue = events.slice().sort((a, b) => a.start - b.start);
      this.title = title;
      this.settings = settings;
      this.deps = deps;
      this.cacheDelayMs = cacheDelayMs;
      this.lines = new Map(); // index -> { t, s }
      this.glossary = [];
      this.glossaryDone = false;
      this.firstDispatched = false;
      this.playhead = 0;
      this.running = 0;
      this.stopped = false;
      this.listeners = [];
      this.cacheTimer = null;

      const size = Math.max(1, settings.batchSize || 30);
      this.batches = [];
      for (let i = 0; i < this.dialogue.length; i += size) {
        const evs = this.dialogue.slice(i, i + size);
        this.batches.push({
          pos: i, events: evs, status: 'pending',
          start: evs[0].start, end: Math.max(...evs.map((e) => e.end)),
        });
      }
    }

    async start() {
      let cached = null;
      try { cached = await this.deps.cacheGet(); } catch { cached = null; }
      if (this.stopped) return;
      if (cached && cached.lines) {
        for (const [k, v] of Object.entries(cached.lines)) {
          if (v && typeof v.t === 'string') this.lines.set(Number(k), { t: v.t, s: v.s || 'llm' });
        }
      }
      for (const b of this.batches) {
        if (b.events.every((e) => this.lines.has(e.index))) b.status = 'done';
      }
      if (cached && Array.isArray(cached.glossary) && cached.glossary.length) {
        this.glossary = cached.glossary;
        this.glossaryDone = true;
      } else if (this.batches.some((b) => b.status === 'pending')) {
        this.requestGlossary();
      } else {
        this.glossaryDone = true;
      }
      this.pump();
    }

    requestGlossary() {
      this.glossaryDone = false;
      const allText = this.dialogue.map((e) => (e.name ? `${e.name}: ` : '') + e.plain.replace(/\n/g, ' ')).join('\n');
      Promise.resolve()
        .then(() => this.deps.glossary(allText))
        .then((terms) => { if (Array.isArray(terms)) this.glossary = terms; })
        .catch(() => {})
        .finally(() => {
          this.glossaryDone = true;
          if (!this.stopped) { this.scheduleCache(); this.pump(); }
        });
    }

    setPlayhead(t) {
      this.playhead = t;
      this.pump();
    }

    nextBatch() {
      const t = this.playhead;
      const pending = this.batches.filter((b) => b.status === 'pending');
      const ahead = pending.filter((b) => b.end >= t).sort((a, b) => a.start - b.start);
      const behind = pending.filter((b) => b.end < t).sort((a, b) => a.start - b.start);
      return ahead[0] || behind[0] || null;
    }

    pump() {
      if (this.stopped) return;
      const limit = Math.max(1, this.settings.concurrency || 5);
      while (this.running < limit) {
        if (!this.glossaryDone && this.firstDispatched) return;
        const b = this.nextBatch();
        if (!b) return;
        this.firstDispatched = true;
        this.run(b);
      }
    }

    batchInput(b) {
      const before = this.dialogue.slice(Math.max(0, b.pos - CONTEXT_LINES), b.pos).map((e) => e.plain);
      const endPos = b.pos + b.events.length;
      const after = this.dialogue.slice(endPos, endPos + CONTEXT_LINES).map((e) => e.plain);
      return { lines: b.events.map((e) => ({ id: e.index, text: e.plain })), before, after };
    }

    run(b) {
      b.status = 'running';
      this.running++;
      const gen = (b.gen = (b.gen || 0) + 1);
      Promise.resolve()
        .then(() => this.deps.translateBatch(this.batchInput(b), { glossary: this.glossary, title: this.title }))
        .then((res) => {
          if (this.stopped || gen !== b.gen) return;
          for (const e of b.events) {
            const t = res.map.get(e.index);
            if (typeof t === 'string' && t) this.lines.set(e.index, { t, s: res.source });
          }
          b.status = 'done';
          b.error = null;
          this.scheduleCache();
        })
        .catch((err) => {
          if (this.stopped || gen !== b.gen) return;
          b.status = 'failed';
          b.error = String((err && err.message) || err);
        })
        .finally(() => {
          this.running--;
          if (this.stopped) return;
          this.emit();
          this.pump();
        });
    }

    batchAt(t) {
      return this.batches.find((b) => b.start <= t && b.end >= t)
        || this.batches.find((b) => b.start > t && b.start <= t + LOOKAHEAD_SEC)
        || null;
    }

    isReadyAt(t) {
      const b = this.batchAt(t);
      return !b || b.status === 'done' || b.status === 'failed';
    }

    getLine(index) {
      return this.lines.get(index);
    }

    stats() {
      let google = 0;
      for (const v of this.lines.values()) if (v.s === 'google') google++;
      return {
        total: this.dialogue.length,
        done: this.lines.size,
        google,
        failedBatches: this.batches.filter((b) => b.status === 'failed').length,
        running: this.running,
        lastError: (this.batches.find((b) => b.error) || {}).error || null,
      };
    }

    onUpdate(cb) {
      this.listeners.push(cb);
    }

    emit() {
      for (const cb of this.listeners) {
        try { cb(this); } catch { /* ignore listener errors */ }
      }
    }

    retranslate(scope) {
      if (this.stopped) return;
      for (const b of this.batches) {
        if (b.status === 'running') continue;
        const redo = scope === 'all'
          || b.status === 'failed'
          || b.events.some((e) => (this.lines.get(e.index) || {}).s === 'google');
        if (redo) b.status = 'pending';
      }
      if (scope === 'all') {
        this.glossary = [];
        this.firstDispatched = false;
        this.requestGlossary();
      }
      this.emit();
      this.pump();
    }

    writeCache() {
      const lines = {};
      for (const [k, v] of this.lines) lines[k] = v;
      const obj = { v: 1, title: this.title, savedAt: Date.now(), glossary: this.glossary, lines };
      Promise.resolve().then(() => this.deps.cacheSet(obj)).catch(() => {});
    }

    scheduleCache() {
      if (this.cacheTimer || this.stopped) return;
      this.cacheTimer = setTimeout(() => {
        this.cacheTimer = null;
        if (!this.stopped) this.writeCache();
      }, this.cacheDelayMs);
    }

    flushCache() {
      if (!this.cacheTimer) return;
      clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
      this.writeCache();
    }

    stop() {
      this.flushCache();
      this.stopped = true;
      this.listeners = [];
    }
  }

  const api = { TrackSession };
  root.CRBS = Object.assign(root.CRBS || {}, api);
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
