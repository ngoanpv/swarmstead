# Configuration

`~/.swarmstead/config.json` (every key is optional):

```json
{
  "port": 4317,
  "capture": "summary",
  "thresholds": { "burnUsdPerMin": 2, "dailyBudgetUsd": 30, "runBudgetUsd": 5, "contextWarn": 0.6 },
  "limits": { "claudeBlockUsd": 150 },
  "gate": { "approvals": true, "waitSubSec": 120, "waitMainSec": 0, "brakes": false },
  "notify": { "desktop": true, "ntfy": "https://ntfy.sh/<long-secret-topic>", "publicUrl": "http://192.168.1.20:4317" },
  "lan": false,
  "autostart": true,
  "reminder": true,
  "pricing": { "my-proxy-model": { "input": 3, "output": 15, "cacheWrite": 3.75, "cacheRead": 0.3 } }
}
```

Costs are **estimates** computed from public list prices (`core/pricing.js`, checked 2026-10-27). On a Claude or ChatGPT subscription, read them as "API-equivalent" cost. They are still a useful efficiency signal.

Every key and its default is in `DEFAULT_CONFIG` in [`server/config.js`](../server/config.js). Detector thresholds are in [DETECTORS.md](DETECTORS.md).
