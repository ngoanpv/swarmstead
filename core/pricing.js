// Approximate list prices in USD per 1M tokens (checked 2026-10-27).
//   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI:    https://developers.openai.com/api/docs/pricing
//
// These are ESTIMATES used to turn token counts into "API-equivalent" cost.
// On a subscription plan (Claude Pro/Max, ChatGPT sign-in for Codex) you are
// not billed per token; the number is still a useful efficiency signal.
// Override or add entries in ~/.swarmstead/config.json:
//   { "pricing": { "my-model": { "input": 3, "output": 15, "cacheWrite": 3.75, "cacheRead": 0.3 } } }
//
// Matching is by case-insensitive substring, FIRST match wins, so specific
// entries come before general ones.

export const DEFAULT_PRICING = [
  // ---- Anthropic / Claude
  { match: 'opus-5-5', input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  { match: 'opus-4-1', input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  { match: 'opus-4-2025', input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  { match: 'opus-4-0', input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  { match: 'opus', input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  { match: 'sonnet-5-5', input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  { match: 'sonnet-5', input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  { match: 'sonnet', input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  { match: 'haiku-5-5', input: 0.1, output: 0.5, cacheWrite: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
  { match: 'haiku-3', input: 0.8, output: 4, cacheWrite: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
  { match: 'haiku', input: 1, output: 5, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  { match: 'fable', input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  { match: 'mythos', input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  // ---- OpenAI (Codex). Input here EXCLUDES cached tokens; the Codex adapter subtracts them.
  { match: 'gpt-6.1-sol', input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  { match: 'gpt-6-astra', input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  { match: 'gpt-6.1-terra', input: 1, output: 5, cacheWrite: 0, cacheRead: 0.05 },
  { match: 'gpt-6-luna', input: 0.1, output: 0.5, cacheWrite: 0, cacheRead: 0.01 },
  { match: 'gpt-5.5', input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 },
  { match: 'codex-mini', input: 0.25, output: 2, cacheWrite: 0, cacheRead: 0.025 },
  { match: 'gpt-5.3-codex', input: 1.75, output: 14, cacheWrite: 0, cacheRead: 0.175 },
  { match: 'gpt-5.2', input: 1.75, output: 14, cacheWrite: 0, cacheRead: 0.175 },
  { match: 'gpt-5-mini', input: 0.25, output: 2, cacheWrite: 0, cacheRead: 0.025 },
  { match: 'gpt-5-nano', input: 0.05, output: 0.4, cacheWrite: 0, cacheRead: 0.005 },
  { match: 'gpt-5', input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 },
];

let table = DEFAULT_PRICING;

/** Put user overrides ({ modelSubstring: {input, output, cacheWrite, cacheRead} }) in front of the defaults. */
export function setPricingOverrides(overrides = {}) {
  const extra = Object.entries(overrides || {}).map(([match, p]) => ({ match: match.toLowerCase(), ...p }));
  table = [...extra, ...DEFAULT_PRICING];
}

export function priceFor(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  for (const p of table) if (m.includes(p.match)) return p;
  return null;
}

/**
 * usage: { model, input, output, cacheRead, cacheWrite, cacheWrite1h?, multiplier? }
 * Token counts; `input` must EXCLUDE cache reads/writes. `cacheWrite1h` is the
 * portion of cacheWrite that used the 1-hour TTL. `multiplier` covers fast mode
 * or regional surcharges.
 */
export function priceUsage(usage) {
  if (!usage) return 0;
  const p = priceFor(usage.model);
  if (!p) return 0;
  const per = 1e-6;
  const w1h = Math.min(usage.cacheWrite1h || 0, usage.cacheWrite || 0);
  const w5m = (usage.cacheWrite || 0) - w1h;
  const usd =
    (usage.input || 0) * p.input * per +
    (usage.output || 0) * p.output * per +
    w5m * p.cacheWrite * per +
    w1h * (p.cacheWrite1h ?? p.cacheWrite * 1.6) * per +
    (usage.cacheRead || 0) * p.cacheRead * per;
  return usd * (usage.multiplier || 1);
}
