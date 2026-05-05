/* @enchanter-ai/plugin-pech — thin re-export shell.
   Canonical implementation lives in the root `enchanter` package at
   src/plugins/pech.adapter.ts; this package republishes those symbols
   under the @enchanter-ai/plugin-pech name so consumers can install
   the cost-ledger plugin standalone with `enchanter` as a peer. */

export { pechAdapter } from 'enchanter';
