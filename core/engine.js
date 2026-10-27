// The Village engine glues World (state), Detectors (issues) and Evolution
// (characters) together. The daemon runs one authoritative instance; the
// browser runs its own instance only in demo mode.

import { World } from './state.js';
import { Detectors } from './detectors.js';
import { Evolution, describe } from './evolution.js';
import { isValidEvent } from './schema.js';

export class Village {
  constructor({ roster = null, thresholds = {}, xpMultiplier = 1, now = Date.now() } = {}) {
    this.world = new World({ now });
    this.detectors = new Detectors(thresholds);
    this.evolution = new Evolution(roster, { xpMultiplier });
    this.rosterDirty = false;
  }

  ingest(ev) {
    if (!isValidEvent(ev)) return [];
    const now = ev.ts || Date.now();
    const fx = this.world.apply(ev);
    return this.process(fx, now);
  }

  process(fx, now) {
    const out = [...fx];
    for (const f of fx) {
      if (f.fx === 'spawn') {
        const a = this.world.agents.get(f.agentId);
        if (a) this.evolution.ensure(a.familiar, { provider: a.provider, project: a.project, type: a.type, now });
        this.rosterDirty = true;
      }
      if (f.fx === 'turn') {
        out.push(...this.evolution.onTurn(f.summary, now, f.agentId));
        this.rosterDirty = true;
      }
      if (f.fx === 'fanin') {
        const parent = this.world.agents.get(f.agentId);
        if (parent && f.total >= 2) {
          out.push(...this.evolution.onRunComplete(parent.familiar, f, now, parent.id));
          this.rosterDirty = true;
        }
      }
    }
    this.detectors.onEffects(this.world, fx, now, out);
    out.push(...this.detectors.evaluate(this.world, now));
    return out;
  }

  tick(now = Date.now()) {
    const fx = [];
    this.world.tickRuns(now, fx);
    const out = fx.length ? this.process(fx, now) : this.detectors.evaluate(this.world, now);
    this.world.gc(now);
    return out;
  }

  snapshot(now = Date.now()) {
    const snap = this.world.snapshot(now);
    const familiars = {};
    for (const a of snap.agents) {
      const f = this.evolution.familiars.get(a.familiar);
      if (f) familiars[a.familiar] = describe(f);
    }
    // stage types inside runs also need their familiar for squads / arena pads
    for (const r of snap.runs) {
      const parent = this.world.agents.get(r.parentId);
      for (const s of r.stages) {
        const key = `${parent?.provider || 'claude'}:${r.project}:${s.type}`;
        const f = this.evolution.familiars.get(key);
        if (f && !familiars[key]) familiars[key] = describe(f);
        s.familiar = key;
      }
    }
    snap.familiars = familiars;
    snap.alerts = this.detectors.list();
    snap.alertHistory = this.detectors.history.slice(-20);
    return snap;
  }

  roster() {
    return this.evolution.roster();
  }
}
