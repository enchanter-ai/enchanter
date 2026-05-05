# @enchanter-ai/plugin-emu

Token economy monitor + ±CI runway forecast — the **Emu** adapter for [Enchanter](https://github.com/enchanter-ai/enchanter).

Emu observes per-call token usage and emits a remaining-runway forecast with a confidence interval. Runs in the `pre-dispatch` and `post-response` lifecycle phases.

## Install

```bash
npm install enchanter @enchanter-ai/plugin-emu
```

`enchanter` is a peer dependency.

## Usage

```ts
import { emuAdapter, configureEmu } from '@enchanter-ai/plugin-emu';
import { McpClient } from 'enchanter';

configureEmu({ remaining_budget: 1_000_000 });

const client = new McpClient({
  // ...transport, server config...
  plugins: [emuAdapter],
});
```

See the root [Enchanter README](https://github.com/enchanter-ai/enchanter#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
