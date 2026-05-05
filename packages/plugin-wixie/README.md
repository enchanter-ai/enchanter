# @enchanter-ai/plugin-wixie

**Placeholder.** Wixie is the prompt-engineering meta-engine that runs the research → craft → converge → harden → translate lifecycle behind Enchanter's architecture spec. It is currently a separate companion repo at <https://github.com/enchanter-ai/wixie> and does **not** yet ship a runtime `PluginAdapter` against the Enchanter event bus.

This package reserves the `@enchanter-ai/plugin-wixie` name on the registry so that a future runtime adapter (planned post-v0.3.2) can publish under it without name-squat negotiation. Until then, the package exports a single `WIXIE_PLACEHOLDER` sentinel.

## Install

```bash
npm install @enchanter-ai/plugin-wixie
```

## Usage

```ts
import { WIXIE_PLACEHOLDER } from '@enchanter-ai/plugin-wixie';
console.log(WIXIE_PLACEHOLDER.upstream);
// → https://github.com/enchanter-ai/wixie
```

## License

Apache-2.0
