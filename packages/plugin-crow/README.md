# @enchanter-ai/plugin-crow

Bayesian trust scoring + info-gain review ordering — the **Crow** adapter for [Enchanter](https://github.com/enchanter-ai/enchanter).

Crow maintains a Beta posterior per source / tool / pattern, scores trust as the posterior mean, and orders pending reviews by expected information gain (entropy reduction).

## Install

```bash
npm install enchanter @enchanter-ai/plugin-crow
```

`enchanter` is a peer dependency.

## Usage

```ts
import { crowAdapter } from '@enchanter-ai/plugin-crow';
import { McpClient } from 'enchanter';

const client = new McpClient({
  // ...transport, server config...
  plugins: [crowAdapter],
});
```

See the root [Enchanter README](https://github.com/enchanter-ai/enchanter#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
