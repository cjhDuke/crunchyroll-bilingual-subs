// 字幕显示层：普通对白自绘，原位字幕交给 ASS.js 渲染。
(function (root) {
  function findVideo() {
    return document.querySelector('.bitmovinplayer-container video') || document.querySelector('#player-container video');
  }

  class Overlay {
    constructor() {
      this.opts = { displayMode: 'bilingual', translationPosition: 'top', fontScale: 1, subtitleOffsetSeconds: 0 };
      this.dialogue = [];
      this.session = null;
      this.positionedAss = null;
      this.positionedText = null;
      this.ass = null;
      this.video = null;
      this.lastKey = '';
      this.toastTimer = null;
      this.raf = null;
      this.loop = this.loop.bind(this);
    }

    setOptions(opts) {
      Object.assign(this.opts, opts);
      this.lastKey = '';
      this.refreshPositioned();
      if (this.video && this.topEl) this.renderAt(this.video.currentTime - this.opts.subtitleOffsetSeconds, this.layout());
    }

    syncPositionedDelay() {
      if (this.ass && this.ass.delay !== this.opts.subtitleOffsetSeconds) {
        // ASS.js 的 delay setter 会重新按 currentTime - delay 定位活动事件，暂停时同样生效。
        this.ass.delay = this.opts.subtitleOffsetSeconds;
      }
    }

    ensureMounted() {
      const video = findVideo();
      if (!video) return false;
      const host = video.parentElement;
      let remounted = false;
      if (!this.root || !this.root.isConnected || this.root.parentElement !== host) {
        if (this.root) this.root.remove();
        this.root = document.createElement('div');
        this.root.className = 'crbs-root';
        this.signsEl = document.createElement('div');
        this.signsEl.className = 'crbs-signs';
        this.area = document.createElement('div');
        this.area.className = 'crbs-area';
        this.bottomEl = document.createElement('div');
        this.bottomEl.className = 'crbs-bottom';
        this.topEl = document.createElement('div');
        this.topEl.className = 'crbs-top';
        this.area.append(this.bottomEl, this.topEl);
        this.toastEl = document.createElement('div');
        this.toastEl.className = 'crbs-toast';
        this.root.append(this.signsEl, this.area, this.toastEl);
        host.appendChild(this.root);
        remounted = true;
        this.lastKey = '';
      }
      if (video !== this.video || remounted) {
        this.video = video;
        this.rebuildPositioned();
      }
      if (!this.raf) this.raf = requestAnimationFrame(this.loop);
      return true;
    }

    setTrack({ dialogue, positionedAss }) {
      this.dialogue = dialogue.slice().sort((a, b) => a.start - b.start);
      this.positionedAss = positionedAss || null;
      this.lastKey = '';
      this.ensureMounted();
      this.refreshPositioned();
    }

    setSession(session) {
      this.session = session;
      this.lastKey = '';
      this.refreshPositioned();
    }

    refreshPositioned() {
      let text = null;
      if (this.positionedAss) {
        try { text = this.positionedAss(this.opts, (index) => this.session && this.session.getLine(index)) || ''; }
        catch (e) { console.warn('[CRBS] 原位字幕生成失败', e); }
      }
      if (text !== this.positionedText) {
        this.positionedText = text;
        this.rebuildPositioned();
      } else this.syncPositionedDelay();
    }

    rebuildPositioned() {
      if (this.ass) {
        try { this.ass.destroy(); } catch { /* ignore */ }
        this.ass = null;
      }
      if (!this.positionedText || !this.video || !this.signsEl || typeof root.ASS !== 'function') return;
      try {
        this.ass = new root.ASS(this.positionedText, this.video, { container: this.signsEl, resampling: 'video_height' });
        this.syncPositionedDelay();
      } catch (e) {
        console.warn('[CRBS] 特效字幕渲染失败', e);
      }
    }

    clear() {
      this.dialogue = [];
      this.session = null;
      this.positionedAss = null;
      this.positionedText = null;
      this.rebuildPositioned();
      this.lastKey = '';
      if (this.bottomEl) { this.bottomEl.textContent = ''; this.topEl.textContent = ''; }
    }

    toast(text, ms = 3000) {
      if (!this.ensureMounted()) return;
      this.toastEl.textContent = text;
      this.toastEl.classList.add('crbs-show');
      clearTimeout(this.toastTimer);
      if (ms > 0) this.toastTimer = setTimeout(() => this.hideToast(), ms);
    }

    hideToast() {
      if (this.toastEl) this.toastEl.classList.remove('crbs-show');
    }

    layout() {
      const v = this.video;
      const w = this.root.clientWidth;
      const h = this.root.clientHeight;
      let cw = w;
      let ch = h;
      if (v.videoWidth && v.videoHeight) {
        const ar = v.videoWidth / v.videoHeight;
        if (w / h > ar) cw = h * ar; else ch = w / ar;
      }
      const key = `${w}x${h}:${cw}x${ch}`;
      if (key !== this.layoutKey) {
        this.layoutKey = key;
        Object.assign(this.area.style, {
          left: `${(w - cw) / 2}px`, top: `${(h - ch) / 2}px`, width: `${cw}px`, height: `${ch}px`,
        });
        this.lastKey = '';
      }
      return ch;
    }

    loop() {
      this.raf = requestAnimationFrame(this.loop);
      if (!this.root || !this.root.isConnected || !this.video || !this.video.isConnected) {
        if (!this.ensureMounted()) return;
      }
      const ch = this.layout();
      this.renderAt(this.video.currentTime - this.opts.subtitleOffsetSeconds, ch);
    }

    renderAt(t, ch) {
      const active = [];
      for (const ev of this.dialogue) {
        if (ev.start > t) break;
        if (ev.end > t) active.push(ev);
      }
      const mode = this.opts.displayMode;
      const parts = active.map((ev) => {
        const tr = this.session && this.session.getLine(ev.index);
        return ev.index + ':' + (tr ? tr.t : '');
      });
      const key = mode + '|' + this.opts.translationPosition + '|' + this.opts.fontScale + '|' + ch + '|' + parts.join('|');
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.render(active, ch);
    }

    render(active, ch) {
      const { displayMode, translationPosition, fontScale } = this.opts;
      const origPx = Math.max(12, ch * 0.046);
      const trPx = Math.max(12, ch * 0.054 * (Number(fontScale) || 1));
      const bottom = [];
      const top = [];
      for (const ev of active) {
        const tr = this.session && this.session.getLine(ev.index);
        if (displayMode === 'translation' && (!tr || typeof tr.t !== 'string' || !tr.t.trim())) continue;
        const line = document.createElement('div');
        line.className = 'crbs-line' + (/ital/i.test(ev.style) ? ' crbs-italic' : '');
        const origEl = document.createElement('div');
        origEl.className = 'crbs-orig';
        origEl.style.fontSize = origPx + 'px';
        origEl.textContent = ev.plain;
        let trEl = null;
        if (tr && displayMode !== 'original') {
          trEl = document.createElement('div');
          trEl.className = 'crbs-tr';
          trEl.style.fontSize = trPx + 'px';
          trEl.textContent = root.CRBS.restoreLineBreaks(tr.t, ev.plain);
        }
        if (displayMode === 'translation') {
          line.append(trEl);
        } else if (trEl) {
          if (translationPosition === 'bottom') line.append(origEl, trEl); else line.append(trEl, origEl);
        } else {
          line.append(origEl);
        }
        ((ev.placement ? ev.placement === 'top' : /top/i.test(ev.style)) ? top : bottom).push(line);
      }
      this.bottomEl.replaceChildren(...bottom);
      this.topEl.replaceChildren(...top);
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      this.raf = null;
      this.clear();
      if (this.root) this.root.remove();
      this.root = null;
    }
  }

  root.CRBS = Object.assign(root.CRBS || {}, { Overlay, findVideo });
})(globalThis);
