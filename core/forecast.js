// Forecasts: what will this run cost, and will you hit your limit first?
//
// - Runs (fan-outs / workflows): compared with past runs of the same workflow
//   (or, for plain fan-outs, the same project). With no history we fall back
//   to "spent so far + agents in flight × average cost per agent".
// - 5-hour block (Claude): current pace extrapolated to the end of the block,
//   against your configured ceiling or your heaviest past blocks.
// - Provider limits (Codex reports used_percent): time until 100% at the
//   current pace, compared with the reset time.
// All numbers are estimates and are labelled with their basis in the UI.

import { median, clamp } from './util.js';

export function similarRuns(run, history = []) {
  const same = run.workflow
    ? history.filter((h) => h.workflow && h.workflow === run.workflow)
    : history.filter((h) => !h.workflow && h.project === run.project);
  return same.slice(-10);
}

export function forecastRun(run, history = [], now = Date.now()) {
  const sim = similarRuns(run, history);
  const finished = run.done + run.failed;
  if (sim.length) {
    const expCost = median(sim.map((h) => h.cost));
    const expTotal = Math.max(1, median(sim.map((h) => h.total)));
    const expDur = median(sim.map((h) => h.durationMs));
    const scale = Math.max(1, run.total / expTotal);
    const projected = run.endedAt ? run.cost : Math.max(run.cost, expCost * scale);
    return {
      basis: 'history', samples: sim.length, expectedCost: expCost, expectedAgents: Math.round(expTotal),
      projectedCost: projected, eta: run.startedAt + expDur * scale, expectedDurationMs: expDur,
      progress: clamp(finished / Math.max(expTotal, run.total), 0, 1),
    };
  }
  if (!finished) return { basis: 'none', projectedCost: null, progress: 0 };
  const perAgent = run.finishedCost / finished;
  return {
    basis: 'in-flight', samples: 0, perAgent,
    projectedCost: run.cost + run.running * perAgent * 0.5, // in-flight agents are, on average, half done
    progress: finished / Math.max(1, run.total),
  };
}

/**
 * block: { start, end, cost } — ceiling: configured $ per block, or null.
 * pastBlocks: costs of earlier finished blocks.
 */
export function forecastBlock(block, now = Date.now(), { ceiling = null, pastBlocks = [] } = {}) {
  if (!block) return null;
  const elapsed = Math.max(5 * 60_000, now - block.start);
  const rate = block.cost / elapsed;            // $ per ms
  const remaining = Math.max(0, block.end - now);
  const projectedEnd = block.cost + rate * remaining;
  const heaviest = pastBlocks.length ? Math.max(...pastBlocks) : null;
  const cap = ceiling || null;
  let eta = null;
  if (cap && rate > 0 && block.cost < cap) eta = now + (cap - block.cost) / rate;
  return {
    rate: rate * 60_000, projectedEnd, ceiling: cap, heaviest, pastBlocks: pastBlocks.length,
    eta, hitsBeforeReset: !!(eta && eta < block.end),
    aboveUsual: heaviest != null && pastBlocks.length >= 3 && projectedEnd > heaviest,
    resetsAt: block.end,
  };
}

/** limit: { primary: { usedPercent, resetsAt }, history: [[ts, usedPercent], ...] } */
export function forecastLimit(limit, now = Date.now()) {
  const used = limit?.primary?.usedPercent;
  if (used == null) return null;
  const hist = (limit.history || []).filter((h) => now - h[0] < 60 * 60_000);
  if (hist.length < 2) return { used, eta: null };
  const [t0, p0] = hist[0], [t1, p1] = hist[hist.length - 1];
  const rate = (p1 - p0) / Math.max(1, t1 - t0); // % per ms
  if (rate <= 0) return { used, eta: null, rate: 0 };
  const eta = now + (100 - used) / rate;
  const resetsAt = limit.primary.resetsAt || null;
  return { used, rate: rate * 60_000, eta, resetsAt, hitsBeforeReset: !resetsAt || eta < resetsAt };
}

/** Compact record of a finished run, for history. */
export function summarizeRun(run, parentType = 'main') {
  return {
    id: run.id, workflow: run.workflow || '', project: run.project, parentType,
    total: run.total, done: run.done, failed: run.failed, cost: run.cost,
    durationMs: (run.endedAt || run.lastActivity) - run.startedAt, endedAt: run.endedAt || run.lastActivity,
    stages: run.stages.map((s) => ({ name: s.name, total: s.total, cost: s.cost })),
  };
}
