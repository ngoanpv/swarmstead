// Tiny chiptune sound effects with WebAudio. Muted by default.

const SFX = {
  coin: [[988, 0.05], [1319, 0.09]],
  level: [[523, 0.07], [659, 0.07], [784, 0.07], [1047, 0.14]],
  evolve: [[392, 0.1], [523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.1], [1319, 0.25]],
  handoff: [[660, 0.04], [880, 0.06]],
  alert: [[220, 0.08], [0, 0.04], [220, 0.12]],
  monster: [[180, 0.06], [140, 0.1]],
  defeat: [[880, 0.05], [660, 0.05], [1175, 0.12]],
  deliver: [[784, 0.04], [1047, 0.07]],
  fanin: [[523, 0.08], [659, 0.08], [784, 0.08], [1047, 0.08], [784, 0.06], [1319, 0.3]],
};

export class Sound {
  constructor() {
    this.enabled = false;
    try { this.enabled = localStorage.getItem('swarmstead.sound') === '1'; } catch {}
    this.ctx = null;
    this.lastAt = {};
  }

  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem('swarmstead.sound', this.enabled ? '1' : '0'); } catch {}
    if (this.enabled) this.play('coin');
    return this.enabled;
  }

  play(name) {
    if (!this.enabled || !SFX[name]) return;
    const now = performance.now();
    if (now - (this.lastAt[name] || 0) < (name === 'coin' ? 120 : 250)) return; // no machine-gun coins
    this.lastAt[name] = now;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      let t = this.ctx.currentTime;
      for (const [freq, dur] of SFX[name]) {
        if (freq > 0) {
          const o = this.ctx.createOscillator(), g = this.ctx.createGain();
          o.type = 'square'; o.frequency.value = freq;
          g.gain.setValueAtTime(0.045, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
          o.connect(g).connect(this.ctx.destination);
          o.start(t); o.stop(t + dur);
        }
        t += dur;
      }
    } catch { /* audio unavailable */ }
  }
}
