// Replay: play back a day (or a shared incident file) through the real engine.
// Seeking rebuilds the world from the start up to the cursor without
// animations, then playback resumes with every effect, at 1× to 120×.

import { Village } from '../core/engine.js';

export class Replay {
  constructor(events, { onFx, onSnapshot, onRoster, onTime } = {}) {
    this.events = events.filter((e) => e && Number.isFinite(e.ts) && !e.backfill).sort((a, b) => a.ts - b.ts);
    this.t0 = this.events[0]?.ts || Date.now();
    this.t1 = this.events[this.events.length - 1]?.ts || this.t0;
    this.onFx = onFx; this.onSnapshot = onSnapshot; this.onRoster = onRoster; this.onTime = onTime;
    this.speed = 10;
    this.playing = false;
    this.timer = null;
    this.seek(this.t0);
  }

  get empty() { return this.events.length === 0; }

  seek(t) {
    this.pause();
    this.village = new Village({ now: this.t0 });
    this.idx = 0;
    this.lastTick = -Infinity;
    const target = Math.max(this.t0, Math.min(this.t1, t));
    while (this.idx < this.events.length && this.events[this.idx].ts <= target) {
      const e = this.events[this.idx++];
      this.village.ingest(e);
      if (e.ts - this.lastTick >= 1000) { this.village.tick(e.ts); this.lastTick = e.ts; }
    }
    this.clock = target;
    this.emitState(true);
  }

  play() {
    if (this.playing || this.empty) return;
    if (this.clock >= this.t1) this.seek(this.t0);
    this.playing = true;
    let lastSnap = 0;
    const step = 100;
    this.timer = setInterval(() => {
      const next = Math.min(this.t1, this.clock + step * this.speed);
      const fx = [];
      while (this.idx < this.events.length && this.events[this.idx].ts <= next) {
        const e = this.events[this.idx++];
        fx.push(...this.village.ingest(e));
      }
      if (next - this.lastTick >= 1000) { fx.push(...this.village.tick(next)); this.lastTick = next; }
      this.clock = next;
      // at high speed, skip the per-coin noise; keep the moments that matter
      const keep = this.speed > 20 ? fx.filter((f) => f.fx !== 'coins' && f.fx !== 'bubble' && f.fx !== 'parallel') : fx;
      if (keep.length) this.onFx?.(keep);
      const now = performance.now();
      if (now - lastSnap > 200) { lastSnap = now; this.emitState(false); }
      if (this.clock >= this.t1) { this.emitState(false); this.pause(); }
    }, step);
  }

  pause() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onTime?.(this.clock, this);
  }

  setSpeed(s) { this.speed = s; }

  emitState(withRoster) {
    this.onSnapshot?.(this.village.snapshot(this.clock));
    if (withRoster) this.onRoster?.(this.village.roster());
    this.onTime?.(this.clock, this);
  }

  destroy() { this.pause(); this.onFx = this.onSnapshot = this.onRoster = this.onTime = null; }
}

/** Accepts a JSON array, {events:[...]}, or JSON Lines. */
export function parseEvents(text) {
  const s = String(text).trim();
  if (!s) return [];
  if (s[0] === '[') return JSON.parse(s);
  if (s[0] === '{' && !s.includes('\n')) { const o = JSON.parse(s); return Array.isArray(o.events) ? o.events : [o]; }
  return s.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
