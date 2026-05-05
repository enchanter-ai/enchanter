# @enchanter-ai/plugin-pech

Cost attribution ledger + budget thresholds — the **Pech** adapter for [Enchanter](https://github.com/enchanter-ai/enchanter).

Pech runs in the `post-response` lifecycle phase, appends a per-call entry to a token-cost ledger (in-memory by default, opt-in JSONL file backing), tracks per-vendor budget consumption, and emits derived events on tier-boundary crossings (`HIGH` → `MED` → `LOW` → `CRITICAL`) and full vendor exhaustion.

## Install

```bash
npm install enchanter @enchanter-ai/plugin-pech
```

`enchanter` is a peer dependency — install it alongside.

## Usage

```ts
import { pechAdapter } from '@enchanter-ai/plugin-pech';
import { McpClient } from 'enchanter';

const client = new McpClient({
  // ...transport, server config...
  plugins: [pechAdapter /* + any other adapters */],
});
```

For ledger configuration (file-backed JSONL, vendor budgets, tier thresholds), import the configurator from the root `enchanter` package:

```ts
import { configurePech } from 'enchanter';

configurePech({
  ledger_path: '/var/log/enchanter/pech-ledger.jsonl',
  vendor_budgets: new Map([['anthropic', { limit_tokens: 1_000_000, used: 0 }]]),
});
```

## Engine

L0 ledger (always on). L2 budget-boundary detection (always on, opt-in via `vendor_budgets`). L1 EMA forecast, L3 Z-score anomaly, and L4 cache-waste are deferred to v0.3.1+.

See the root [Enchanter README](https://github.com/enchanter-ai/enchanter#readme) for the full lifecycle, plugin contract, and architectural context.

## License

Apache-2.0
