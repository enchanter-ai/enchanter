# @enchanter-ai/plugin-gorgon

Codebase structural intelligence with PageRank hotspots — the **Gorgon** adapter for [Enchanter](https://github.com/enchanter-ai/enchanter).

Gorgon ingests the project's import graph, computes per-module PageRank to surface structural hotspots, runs Tarjan SCC for cycle detection, and tags responses with relevant hotspot context.

## Install

```bash
npm install enchanter @enchanter-ai/plugin-gorgon
```

`enchanter` is a peer dependency.

## Usage

```ts
import { gorgonAdapter, configureGorgon } from '@enchanter-ai/plugin-gorgon';
import { McpClient } from 'enchanter';

const client = new McpClient({
  // ...transport, server config...
  plugins: [gorgonAdapter],
});
```

See the root [Enchanter README](https://github.com/enchanter-ai/enchanter#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
