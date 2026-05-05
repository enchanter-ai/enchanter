# @enchanter-ai/plugin-djinn

Intent anchoring + drift detection across `/compact` — the **Djinn** adapter for [Enchanter](https://github.com/enchanter-ai/enchanter).

Djinn captures a session anchor at the start of a request and detects drift between the user's stated intent and the actual sequence of tool calls — including across `/compact` boundaries that erase short-term context.

## Install

```bash
npm install enchanter @enchanter-ai/plugin-djinn
```

`enchanter` is a peer dependency.

## Usage

```ts
import { djinnAdapter } from '@enchanter-ai/plugin-djinn';
import { McpClient } from 'enchanter';

const client = new McpClient({
  // ...transport, server config...
  plugins: [djinnAdapter],
});
```

See the root [Enchanter README](https://github.com/enchanter-ai/enchanter#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
