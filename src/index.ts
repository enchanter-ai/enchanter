/* enchanter/src/index.ts — public entrypoint for the v0.1 reference. */

// Core types
export type { LifecyclePhase, BudgetTier, RequestContext } from './orchestration/request-context.js';
export type { EnchantedEvent, EventHandler, Subscription, PluginAck } from './bus/event-types.js';
export type { PluginAdapter, PluginRegistry, BudgetTierGate } from './plugins/plugin-contract.js';

// Constructors
export { createRequestContext, LIFECYCLE_PHASES, DEFAULT_PHASE_TIMEOUTS_MS } from './orchestration/request-context.js';
export { Orchestrator, SecurityVetoError, PhaseTimeoutError } from './orchestration/lifecycle.js';
export { InProcessBus } from './bus/pubsub.js';

// High-level client
export { McpClient } from './client/mcp-client.js';
export type { Transport, ServerInfo, ToolDescriptor, McpClientConfig } from './client/mcp-client.js';

// Transport
export { StdioTransport, BodyTooLargeError, PER_MESSAGE_BODY_MAX_BYTES } from './transport/stdio.js';
export {
  StreamableHttpTransport,
  StreamableHttpResumeError,
  StreamableHttpMaxRetriesError,
} from './transport/streamable-http.js';

// OAuth
export { generateCodeVerifier, deriveS256Challenge, verifyS256, validateVerifier } from './oauth/pkce.js';
export {
  validateAudience,
  buildResourceParameter,
  AudienceMismatchError,
  bindReplayDefense,
  consumeReplayDefense,
  ReplayDefenseError,
} from './oauth/resource-indicators.js';
export type { ReplayDefenseParams } from './oauth/resource-indicators.js';
export { validateMetadataUrl, SsrfRejectionError } from './oauth/metadata-validator.js';
export {
  InMemoryReplayStore,
  PersistentReplayStore,
  DEFAULT_FRESHNESS_SECONDS,
  MAX_ENTRIES,
} from './oauth/replay-store.js';
export type { ReplayStore, ConsumeResult, ConsumeFailure } from './oauth/replay-store.js';
export { generateNonce, encodeTimestamp, parseTimestamp, isFresh } from './oauth/nonce.js';

// Registry
export {
  NamespaceRegistry,
  ToolNameCollisionError,
  ToolNotFoundError,
  SchemaDigestMismatchError,
  computeSchemaDigest,
} from './registry/namespace.js';

// Protocol
export {
  parseJsonRpc,
  serializeJsonRpc,
  JsonRpcParseError,
  EmbeddedNewlineError,
  JSONRPC_ERROR,
} from './protocol/jsonrpc.js';
export type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, JsonRpcError } from './protocol/jsonrpc.js';

// Plugins
export { hydraAdapter, configureHydra, maskSecrets, matchCvePatterns } from './plugins/hydra.adapter.js';
export { crowAdapter } from './plugins/crow.adapter.js';
export { djinnAdapter } from './plugins/djinn.adapter.js';
export { emuAdapter } from './plugins/emu.adapter.js';
export { gorgonAdapter } from './plugins/gorgon.adapter.js';
export { lichAdapter } from './plugins/lich.adapter.js';
export { nagaAdapter } from './plugins/naga.adapter.js';
export { pechAdapter } from './plugins/pech.adapter.js';
export { sylphAdapter } from './plugins/sylph.adapter.js';
