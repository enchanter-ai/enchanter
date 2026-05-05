# @enchanter-ai/plugin-sylph

Git workflow automation + destructive-op gate — the **Sylph** adapter for [Enchanter](https://github.com/enchanter-ai/enchanter).

Sylph runs in `trust-gate` and `post-session` lifecycle phases. It clusters edits, gates destructive git operations (force-push, hard-reset, branch-delete), and proposes commit / branch automation at session boundaries.

## Install

```bash
npm install enchanter @enchanter-ai/plugin-sylph
```

`enchanter` is a peer dependency.

## Usage

```ts
import { sylphAdapter } from '@enchanter-ai/plugin-sylph';
import { McpClient } from 'enchanter';

const client = new McpClient({
  // ...transport, server config...
  plugins: [sylphAdapter],
});
```

See the root [Enchanter README](https://github.com/enchanter-ai/enchanter#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
