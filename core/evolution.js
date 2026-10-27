// Character evolution.
//
// Every agent identity (provider + project + agent type) owns a persistent
// "familiar" that lives across sessions. Each live agent you see is that
// familiar at work. Familiars earn XP for *finished turns*, and the XP formula
// rewards quality and efficiency, never raw token burn:
//
//   xp = 10 · work · quality · thrift · cache  +  15 · bugsSlain  +  cleanBonus
//
//   work    = how much real work the turn did (edits, runs, delegations), capped
//   quality = 1 − penalties for loops, repeated errors, forced compaction
//   thrift  = this turn's cost-per-work vs. the familiar's own moving baseline
//             (beat your own average → up to 1.75×; twice as wasteful → 0.5×)
//   cache   = 1 + 0.25 · cache-hit ratio
//
// Behaviour decides WHAT it becomes (species/lineage), performance decides
// WHETHER it can evolve (stat gates), and habits leave visible marks:
//   - species  = dominant work style when it hatches (reader → owl, builder → fox …)
//   - branch   = Zen (high Focus) or Alchemist (high Thrift) at the Master stage
//   - shiny    = earned by a 10-turn clean streak (or a 1/128 lucky hatch)
//   - glitch   = "corruption" from loops/repeated errors; decays with clean turns
//   - accessory = secondary work style (glasses, hammer, antenna, scarf, cape)
//
// Everything is deterministic given the same turn summaries, so the roster can
// be rebuilt from the event log and tested.

import { clamp, ema, hash32, rng, pick } from './util.js';

export const TRAITS = ['scholar', 'smith', 'engineer', 'ranger', 'commander'];

// names[stage - 1]; Master and Legend have a [zen, alchemist] pair.
export const SPECIES = {
  scholar: { species: 'owl', names: ['Hootlet', 'Scribowl', ['Sage Owl', 'Alchemowl'], ['Oracle of Tomes', 'Golden Grimoire']] },
  smith: { species: 'fox', names: ['Kit', 'Codefox', ['Zen Kitsune', 'Forgefox'], ['Ninetail', 'Sunforge Kitsune']] },
  engineer: { species: 'bot', names: ['Boltling', 'Gearbot', ['Zen Golem', 'Brass Automaton'], ['Synthwarden', 'Gilded Colossus']] },
  ranger: { species: 'bunny', names: ['Hopper', 'Scoutbun', ['Moonhare', 'Treasure Hare'], ['Star Strider', 'Comet Hare']] },
  commander: { species: 'cat', names: ['Kitten', 'Captain Cat', ['Zen Sphinx', 'Merchant Lion'], ['Celestial Sphinx', 'Sun King']] },
};

export const STAGES = ['Egg', 'Hatchling', 'Adept', 'Master', 'Legend'];

/** Evolution gates: level AND a performance condition. */
export const GATES = [
  null,
  { level: 2, test: () => true, need: 'finish a turn' },
  { level: 6, test: (f) => f.bugsSlain >= 1 || f.turns >= 10, need: 'slay a bug or finish 10 turns' },
  { level: 14, test: (f) => f.stats.focus >= 55, need: 'Focus ≥ 55' },
  { level: 28, test: (f) => f.bestStreak >= 10 && (f.stats.thrift >= 55 || f.stats.focus >= 80), need: '10-turn clean streak + Thrift ≥ 55' },
];

const ACCESSORY = { scholar: 'glasses', smith: 'hammer', engineer: 'antenna', ranger: 'scarf', commander: 'cape' };
const NAMES = ['Mochi', 'Bao', 'Tofu', 'Pixel', 'Nori', 'Kiwi', 'Taro', 'Miso', 'Boba', 'Chai', 'Yuzu', 'Pho',
  'Banh', 'Xoi', 'Che', 'Mango', 'Sesame', 'Dumpling', 'Bean', 'Pudding', 'Matcha', 'Lychee', 'Sumo', 'Biscuit'];

export const xpForLevel = (level) => Math.round(40 * Math.pow(level, 1.5)); // xp needed to go level -> level+1

export function levelFromXp(xp) {
  let level = 1, need = xpForLevel(1), acc = 0;
  while (xp >= acc + need && level < 99) { acc += need; level++; need = xpForLevel(level); }
  return { level, into: xp - acc, need };
}

/** How the turn's work splits across the five work styles (sums to 1, or all 0). */
export function traitMix(cat = {}) {
  const raw = {
    scholar: (cat.read || 0) + 0.5 * (cat.plan || 0),
    smith: (cat.write || 0) * 1.2,
    engineer: cat.run || 0,
    ranger: (cat.web || 0) * 1.5 + 0.5 * (cat.tool || 0),
    commander: (cat.delegate || 0) * 3,
  };
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  if (!sum) return Object.fromEntries(TRAITS.map((k) => [k, 0]));
  return Object.fromEntries(TRAITS.map((k) => [k, raw[k] / sum]));
}

/** The score sheet for one finished turn. Pure function — easy to test and tune. */
export function scoreTurn(s, f) {
  const edits = Math.min(s.edits || 0, 8), runs = Math.min(s.runs || 0, 8), tools = Math.min(s.tools || 0, 30);
  const work = clamp(1 + 0.5 * edits + 0.25 * runs + 1 * (s.returns || 0) + 0.15 * tools, 1, 8);
  const autoCompactions = s.compactions || 0;
  const quality = clamp(1 - 0.35 * (s.loops || 0) - 0.2 * (s.errorEchoes || 0) - 0.1 * autoCompactions, 0.1, 1);
  const cpw = (s.cost || 0) / work;
  const baseline = f?.baselineCpw;
  const thrift = baseline && cpw > 0 ? clamp(baseline / cpw, 0.5, 1.75) : 1;
  const ctxTokens = (s.input || 0) + (s.cacheRead || 0) + (s.cacheWrite || 0);
  const cacheRatio = ctxTokens ? (s.cacheRead || 0) / ctxTokens : 0;
  const cache = 1 + 0.25 * cacheRatio;
  const clean = quality >= 0.95 && !(s.loops || 0) && !(s.errorEchoes || 0) && (s.tools || 0) > 0;
  const bugs = s.testFixes || 0;
  let xp = 10 * work * quality * thrift * cache + 15 * bugs + (clean ? 5 : 0);
  if ((s.tools || 0) === 0 && !(s.output > 0)) xp = 1; // pure chat turns still count a little
  return { xp: Math.max(1, Math.round(xp)), work, quality, thrift, cache, cacheRatio, cpw, clean, bugs };
}

export class Evolution {
  constructor(json = null, { xpMultiplier = 1 } = {}) {
    this.familiars = new Map();
    this.xpMultiplier = xpMultiplier;
    if (json?.familiars) for (const f of json.familiars) this.familiars.set(f.key, f);
  }

  ensure(key, meta = {}) {
    let f = this.familiars.get(key);
    if (f) return f;
    const seed = hash32(key);
    const r = rng(seed);
    const hue = Math.floor(r() * 360);
    f = {
      key, provider: meta.provider || 'claude', project: meta.project || '', type: meta.type || 'main',
      name: pick(r, NAMES), seed,
      xp: 0, level: 1, stage: 0, trait: null, branch: null,
      traits: Object.fromEntries(TRAITS.map((k) => [k, 0.2])),
      stats: { focus: 60, thrift: 50, craft: 40, cache: 0, grit: 0 },
      baselineCpw: null, turns: 0, bugsSlain: 0, perfectStreak: 0, bestStreak: 0,
      shiny: r() < 1 / 128, corruption: 0,
      genome: {
        hue, accentHue: (hue + 140 + Math.floor(r() * 80)) % 360,
        pattern: pick(r, ['plain', 'spots', 'belly', 'stripes', 'mask']),
        eyes: pick(r, ['dot', 'big', 'happy', 'sparkle']),
      },
      totalCost: 0, born: meta.now || Date.now(), lastSeen: meta.now || Date.now(),
      history: [],
    };
    this.familiars.set(key, f);
    return f;
  }

  /** Apply one finished turn. Returns render effects (xp popups, level ups, evolutions). */
  onTurn(summary, now = Date.now(), agentId = summary.agentId) {
    const fx = [];
    const f = this.ensure(summary.familiar, { ...summary, now });
    const sc = scoreTurn(summary, f);
    const gained = Math.max(1, Math.round(sc.xp * this.xpMultiplier));

    // --- behaviour & stats (moving averages, so habits matter more than one-offs)
    const mix = traitMix(summary.cat);
    if ((summary.tools || 0) > 0) for (const k of TRAITS) f.traits[k] = ema(f.traits[k], mix[k], 0.15);
    f.stats.focus = Math.round(ema(f.stats.focus, sc.quality * 100, 0.2));
    if (sc.cpw > 0) {
      const thriftSample = f.baselineCpw ? clamp(50 * (f.baselineCpw / sc.cpw), 0, 100) : 50;
      f.stats.thrift = Math.round(ema(f.stats.thrift, thriftSample, 0.2));
      f.baselineCpw = ema(f.baselineCpw, sc.cpw, 0.1);
    }
    f.stats.cache = Math.round(ema(f.stats.cache, sc.cacheRatio * 100, 0.2));
    const craftSample = 30 * Math.min(summary.edits || 0, 3) / 3 + 40 * (sc.bugs > 0 ? 1 : 0) + 30 * ((summary.failedRuns || 0) === 0 ? 1 : 0);
    f.stats.craft = Math.round(ema(f.stats.craft, craftSample, 0.2));
    f.turns++;
    f.bugsSlain += sc.bugs;
    f.stats.grit = Math.min(100, Math.round(20 * Math.log2(1 + f.turns) + 3 * f.bugsSlain));
    f.totalCost += summary.cost || 0;
    f.lastSeen = now;

    // --- streaks, shiny, corruption
    if (sc.clean) f.perfectStreak++; else if ((summary.tools || 0) > 0) f.perfectStreak = 0;
    f.bestStreak = Math.max(f.bestStreak, f.perfectStreak);
    const sins = (summary.loops || 0) + (summary.errorEchoes || 0);
    f.corruption = clamp(sins ? f.corruption + 0.25 * sins : f.corruption - (sc.clean ? 0.15 : 0.05), 0, 1);
    if (!f.shiny && f.perfectStreak >= 10) {
      f.shiny = true;
      f.history.push({ ts: now, event: 'shiny' });
      fx.push({ fx: 'shiny', familiar: f.key, agentId });
    }

    // --- xp & level
    const before = f.level;
    f.xp += gained;
    const lv = levelFromXp(f.xp);
    f.level = lv.level;
    fx.push({ fx: 'xp', familiar: f.key, agentId, xp: gained, score: sc });
    if (f.level > before) {
      fx.push({ fx: 'levelup', familiar: f.key, agentId, level: f.level });
      f.history.push({ ts: now, event: 'level', level: f.level });
    }

    // --- evolution: may jump several stages if a long-lived familiar is imported
    while (f.stage < 4) {
      const gate = GATES[f.stage + 1];
      if (f.level < gate.level || !gate.test(f)) break;
      const from = displayName(f);
      f.stage++;
      if (f.stage === 1) f.trait = dominantTrait(f.traits);
      if (f.stage === 3) f.branch = f.stats.focus >= f.stats.thrift ? 'zen' : 'alchemist';
      const to = displayName(f);
      f.history.push({ ts: now, event: f.stage === 1 ? 'hatch' : 'evolve', from, to, stage: f.stage });
      fx.push({ fx: f.stage === 1 ? 'hatch' : 'evolve', familiar: f.key, agentId, from, to, stage: f.stage });
    }
    if (f.history.length > 60) f.history.splice(0, f.history.length - 60);
    return fx;
  }

  view(key) {
    const f = this.familiars.get(key);
    return f ? describe(f) : null;
  }

  toJSON() {
    return { version: 1, familiars: [...this.familiars.values()] };
  }

  roster() {
    return [...this.familiars.values()].map(describe).sort((a, b) => b.xp - a.xp);
  }
}

export function dominantTrait(traits) {
  let best = 'smith', v = -1;
  for (const k of TRAITS) if (traits[k] > v) { v = traits[k]; best = k; }
  return best;
}

export function secondaryTrait(f) {
  const main = f.trait || dominantTrait(f.traits);
  let best = null, v = 0.18; // must be a meaningful share to show
  for (const k of TRAITS) if (k !== main && f.traits[k] > v) { v = f.traits[k]; best = k; }
  return best;
}

export function displayName(f) {
  if (f.stage === 0) return 'Egg';
  const line = SPECIES[f.trait || 'smith'];
  const n = line.names[f.stage - 1];
  return Array.isArray(n) ? n[f.branch === 'alchemist' ? 1 : 0] : n;
}

/** Everything the renderer needs to draw this familiar. */
export function describe(f) {
  const trait = f.trait || dominantTrait(f.traits);
  const lv = levelFromXp(f.xp);
  const next = GATES[f.stage + 1];
  const sec = f.stage >= 2 ? secondaryTrait(f) : null;
  return {
    key: f.key, name: f.name, project: f.project, type: f.type, provider: f.provider,
    xp: f.xp, level: f.level, into: lv.into, need: lv.need,
    stage: f.stage, stageName: STAGES[f.stage], form: displayName(f),
    trait, species: f.stage === 0 ? 'egg' : SPECIES[trait].species, branch: f.branch,
    accessory: sec ? ACCESSORY[sec] : null,
    shiny: f.shiny, corruption: f.corruption, genome: f.genome, stats: { ...f.stats }, traits: { ...f.traits },
    turns: f.turns, bugsSlain: f.bugsSlain, streak: f.perfectStreak, bestStreak: f.bestStreak, totalCost: f.totalCost,
    nextGate: next ? { level: next.level, need: next.need, ready: f.level >= next.level && next.test(f) } : null,
    history: f.history.slice(-12),
  };
}
