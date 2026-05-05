# @enchanter-ai/plugin-hydra

Real-time security interception with 1844 CVE-mapped patterns — the **Hydra** adapter for [Enchanter](https://github.com/enchanter-ai/enchanter).

Hydra runs in the `trust-gate` and `post-response` lifecycle phases. It vetos calls matching destructive-op patterns, masks secrets (AWS keys, bearer tokens, PEM blocks) in tool results, and emits findings tagged with the matched CVE ID.

## Install

```bash
npm install enchanter @enchanter-ai/plugin-hydra
```

`enchanter` is a peer dependency.

## Usage

```ts
import { hydraAdapter, configureHydra, maskSecrets, matchCvePatterns } from '@enchanter-ai/plugin-hydra';
import { McpClient } from 'enchanter';

const client = new McpClient({
  // ...transport, server config...
  plugins: [hydraAdapter],
});
```

See the root [Enchanter README](https://github.com/enchanter-ai/enchanter#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
