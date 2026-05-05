/* @enchanter-ai/plugin-wixie — placeholder package.

   Wixie is the prompt-engineering meta-engine that companion-runs the
   research → craft → converge → harden → translate lifecycle. Today it
   does NOT ship a runtime PluginAdapter against the Enchanter bus — it
   is a separate companion repo (https://github.com/enchanter-ai/wixie).

   This package reserves the `@enchanter-ai/plugin-wixie` name on the
   registry so a future runtime adapter (planned post-v0.3.2) can ship
   under it without a name-squat negotiation. Until that adapter lands,
   this module exports a single `WIXIE_PLACEHOLDER` sentinel so the
   import is non-empty and the build succeeds. */

export const WIXIE_PLACEHOLDER = {
  name: 'wixie',
  status: 'placeholder',
  upstream: 'https://github.com/enchanter-ai/wixie',
} as const;
