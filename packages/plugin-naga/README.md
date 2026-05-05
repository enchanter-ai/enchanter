# @enchanter-ai/plugin-naga

Structural replication via AST + TF-IDF + naming convention — the **Naga** adapter for [Enchanter](https://github.com/enchanter-ai/enchanter).

Naga runs in `trust-gate`, `post-response`, and `post-session`. It builds a triple-axis fingerprint (AST shape + TF-IDF term vector + naming convention) of session artifacts and detects structural drift across edits.

## Install

```bash
npm install enchanter @enchanter-ai/plugin-naga
```

`enchanter` is a peer dependency.

## Usage

```ts
import { nagaAdapter } from '@enchanter-ai/plugin-naga';
import { McpClient } from 'enchanter';

const client = new McpClient({
  // ...transport, server config...
  plugins: [nagaAdapter],
});
```

See the root [Enchanter README](https://github.com/enchanter-ai/enchanter#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
