# @enchanter-ai/plugin-lich

Code review with sandboxed confirmation + Bayesian preference — the **Lich** adapter for [Enchanter](https://github.com/enchanter-ai/enchanter).

Lich runs in `post-response`. It pattern-matches suspicious tool results, optionally confirms findings inside a sandbox, and tracks per-pattern false-positive rates via Bayesian preference learning.

## Install

```bash
npm install enchanter @enchanter-ai/plugin-lich
```

`enchanter` is a peer dependency.

## Usage

```ts
import { lichAdapter, configureLich } from '@enchanter-ai/plugin-lich';
import { McpClient } from 'enchanter';

const client = new McpClient({
  // ...transport, server config...
  plugins: [lichAdapter],
});
```

See the root [Enchanter README](https://github.com/enchanter-ai/enchanter#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
