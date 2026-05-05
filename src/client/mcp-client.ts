/* enchanter/src/client/mcp-client.ts — high-level glue: wires StdioTransport
   (or any Transport-shaped object) + NamespaceRegistry + Orchestrator + plugin
   registry into one usable client. Owns JSON-RPC request/response correlation
   via a pending-promise map keyed by id.

   Architecture-spec phase_2 ADR-001 (hybrid coordination): the McpClient is the
   thin orchestrator-facing layer; plugins still observe everything via the bus. */

import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from '../protocol/jsonrpc.js';
import { JSONRPC_ERROR } from '../protocol/jsonrpc.js';
import { NamespaceRegistry, type ToolSchema } from '../registry/namespace.js';
import { Orchestrator } from '../orchestration/lifecycle.js';
import { createRequestContext, type BudgetTier } from '../orchestration/request-context.js';
import { InProcessBus } from '../bus/pubsub.js';
import type { PluginAdapter } from '../plugins/plugin-contract.js';
import { enforceTrustPin, type TrustPinInputs, type TrustPinStore } from '../registry/trust-pin.js';
import type { TransportDescriptor } from '../transport/transport-descriptor.js';

export interface Transport {
  send(msg: JsonRpcMessage): Promise<void>;
  recv(): AsyncIterableIterator<JsonRpcMessage>;
}

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly capabilities: Record<string, unknown>;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface McpClientConfig {
  /** Identity used for every tools/call collision check. */
  readonly serverId: string;
  readonly transport: Transport;
  readonly plugins?: ReadonlyArray<PluginAdapter>;
  /** Override the default in-process bus + orchestrator. */
  readonly bus?: InProcessBus;
  /** Initial budget tier for new requests. */
  readonly budgetTier?: BudgetTier;
  /**
   * Optional trust-pin store (FM 10 MCPoison closure). When provided, every
   * tools/call runs `enforceTrustPin` during the trust-gate phase. Default
   * undefined → enforcement is OFF (back-compat with v0.3.1 callers).
   */
  readonly trustPinStore?: TrustPinStore;
  /**
   * Optional URL for remote (Streamable-HTTP) MCP servers. Folded into the
   * trust-pin digest when present; absent for stdio servers. Optional even
   * when `trustPinStore` is set — stdio callers leave it undefined.
   *
   * Prefer supplying `transportDescriptor` (kind: 'http') instead — when both
   * are present the descriptor wins and `serverUrl` is ignored.
   */
  readonly serverUrl?: string;
  /**
   * v0.4 follow-up #2 — transport-launch-time inputs that fill the rest of
   * the trust-pin digest (cmd, binaryDigest, envAllowlist for stdio; url
   * for http). Optional for back-compat: when absent, the trust-gate hook
   * falls back to the v0.3.2 behavior (only args, optional serverUrl, and
   * schemaDigests participate). Build via `describeStdio()` / `describeHttp()`
   * from `src/transport/transport-descriptor.ts`.
   */
  readonly transportDescriptor?: TransportDescriptor;
}

/**
 * Compose the `TrustPinInputs` for the trust-gate hook. Pulls cmd /
 * binaryDigest / envAllowlist (stdio) or url (http) from the descriptor
 * when present, and folds in per-call args + schema digests. Missing
 * descriptor fields are omitted entirely so the digest stays stable per
 * trust-pin canonicalization rules.
 *
 * Exported for the v0.4 integration test; not part of the public API.
 */
export function buildTrustPinInputs(args: {
  descriptor?: TransportDescriptor;
  fallbackUrl?: string;
  callArgs: readonly string[];
  schemaDigests: readonly string[];
}): TrustPinInputs {
  const inputs: TrustPinInputs = {
    args: [...args.callArgs],
    schemaDigests: args.schemaDigests,
  };
  if (args.descriptor) {
    if (args.descriptor.kind === 'stdio') {
      return {
        ...inputs,
        cmd: args.descriptor.cmd,
        ...(args.descriptor.binaryDigest !== undefined ? { binaryDigest: args.descriptor.binaryDigest } : {}),
        envAllowlist: args.descriptor.envAllowlist,
      };
    }
    // http
    return { ...inputs, url: args.descriptor.url };
  }
  // No descriptor — preserve v0.3.2 behavior.
  if (args.fallbackUrl !== undefined) {
    return { ...inputs, url: args.fallbackUrl };
  }
  return inputs;
}

export class McpClient {
  readonly serverId: string;
  readonly registry: NamespaceRegistry;
  readonly bus: InProcessBus;
  readonly orchestrator: Orchestrator;
  private readonly transport: Transport;
  private readonly budgetTier: BudgetTier;
  private readonly trustPinStore?: TrustPinStore;
  private readonly serverUrl?: string;
  private readonly transportDescriptor?: TransportDescriptor;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (msg: JsonRpcResponse) => void; reject: (err: Error) => void }
  >();
  private receiveLoopStarted = false;
  private serverInfo?: ServerInfo;

  constructor(config: McpClientConfig) {
    this.serverId = config.serverId;
    this.transport = config.transport;
    this.budgetTier = config.budgetTier ?? 'HIGH';
    this.trustPinStore = config.trustPinStore;
    this.serverUrl = config.serverUrl;
    this.transportDescriptor = config.transportDescriptor;
    this.registry = new NamespaceRegistry();
    this.bus = config.bus ?? new InProcessBus();

    const pluginMap = new Map<string, PluginAdapter>();
    for (const p of config.plugins ?? []) pluginMap.set(p.name, p);
    this.orchestrator = new Orchestrator({ registry: pluginMap, bus: this.bus });
  }

  /** Start the background receive loop — call once before send. */
  start(): void {
    if (this.receiveLoopStarted) return;
    this.receiveLoopStarted = true;
    void this.runReceiveLoop();
  }

  /** MCP initialize handshake. Returns server info + capabilities. */
  async initialize(clientName: string, clientVersion: string): Promise<ServerInfo> {
    this.start();
    const resp = await this.sendRequest('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { sampling: {}, roots: {}, elicitation: {} },
      clientInfo: { name: clientName, version: clientVersion },
    });
    if (resp.error) {
      throw new Error(`initialize failed: ${resp.error.message}`);
    }
    const result = resp.result as { serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> };
    this.serverInfo = {
      name: result.serverInfo?.name ?? 'unknown',
      version: result.serverInfo?.version ?? '0.0.0',
      capabilities: result.capabilities ?? {},
    };
    // Send the post-initialize notification per MCP spec.
    await this.transport.send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    return this.serverInfo;
  }

  /** tools/list — registers each in the namespace registry by `serverId.tool_name`. */
  async listTools(): Promise<ToolDescriptor[]> {
    const resp = await this.sendRequest('tools/list', {});
    if (resp.error) throw new Error(`tools/list failed: ${resp.error.message}`);
    const result = resp.result as { tools?: ToolDescriptor[] };
    const tools = result.tools ?? [];
    for (const t of tools) {
      const schema: ToolSchema = {
        description: t.description,
        inputSchema: t.inputSchema,
      };
      try {
        this.registry.register(this.serverId, t.name, schema);
      } catch {
        // Re-registration with mutated schema throws (MCPoison defense).
        // Re-throw to caller so they can surface re-consent.
        throw new Error(`tool ${t.name} schema mutated since pin — re-consent required`);
      }
    }
    return tools;
  }

  /** tools/call — runs the full 7-phase orchestrator lifecycle. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // Resolve via namespace registry — throws on collision (failure-mode 1).
    const ident = this.registry.resolve(name);

    const ctx = createRequestContext({
      mcp_server_id: this.serverId,
      tool_call_id: ident.bare_name,
      budget_tier: this.budgetTier,
    });

    // Pre-publish the architecture-spec trust-gate topic so subscribed
    // plugins (hydra, sylph, naga, crow) ack before the orchestrator's
    // trust-gate wait. The wired subscription handler stores acks in
    // AckTracker keyed by (correlation_id, phase, plugin).
    await this.bus.publish('mcp.tool.call.requested', {
      correlation_id: ctx.correlation_id,
      session_id: ctx.session_id,
      phase: 'trust-gate',
      source: 'mcp-client',
      budget_tier: ctx.budget_tier,
      payload: { tool: ident.bare_name, args, server_id: this.serverId },
    });

    // Build the trust-gate hook only when a store is configured (back-compat:
    // undefined trustPinStore → orchestrator skips the hook).
    const trustGateHook = this.trustPinStore
      ? async (hookCtx: { ctx: typeof ctx; transportDescriptor?: TransportDescriptor }): Promise<void> => {
          // v0.4 follow-up #2: when `transportDescriptor` is supplied, the
          // launch-time fields (cmd, binaryDigest, envAllowlist for stdio;
          // url for http) join the digest alongside the per-call `args` and
          // the registry-derived `schemaDigests`. Without a descriptor we
          // fall back to v0.3.2 behavior (args + optional serverUrl + schemas).
          //
          // The per-call `args` field intentionally remains
          // [bare_name, JSON.stringify(args)] — that's what enforceTrustPin
          // already pins against and existing tests rely on it. Launch-time
          // `args` from the descriptor would conflict; the digest's purpose
          // is server-identity, and the per-call args are the live request.
          const inputs = buildTrustPinInputs({
            descriptor: hookCtx.transportDescriptor,
            fallbackUrl: this.serverUrl,
            callArgs: [ident.bare_name, JSON.stringify(args)],
            schemaDigests: this.registry.schemaDigestsFor(this.serverId),
          });
          await enforceTrustPin(this.trustPinStore!, this.serverId, inputs, this.bus, {
            correlation_id: hookCtx.ctx.correlation_id,
            session_id: hookCtx.ctx.session_id,
            phase: 'trust-gate',
          });
        }
      : undefined;

    return this.orchestrator.run(
      ctx,
      async () => {
        const resp = await this.sendRequest('tools/call', {
          name: ident.bare_name,
          arguments: args,
        });
        if (resp.error) {
          throw new Error(`tools/call ${name}: ${resp.error.message}`);
        }
        // Pre-publish post-response topic for hydra (secret mask), pech (ledger),
        // lich (review), emu (forecast), naga (artifact shape-check).
        await this.bus.publish('mcp.tool.result.received', {
          correlation_id: ctx.correlation_id,
          session_id: ctx.session_id,
          phase: 'post-response',
          source: 'mcp-client',
          budget_tier: ctx.budget_tier,
          payload: {
            tool: ident.bare_name,
            result: resp.result,
            vendor: this.serverId,
            tokens: { input: 0, output: 0 },
          },
        });
        return resp.result;
      },
      trustGateHook
        ? this.transportDescriptor
          ? { trustGateHook, transportDescriptor: this.transportDescriptor }
          : { trustGateHook }
        : {},
    );
  }

  /** Publish a synthetic trust-gate event (used by tests + power-user paths). */
  async publishTrustGate(toolCall: { tool: string; args: unknown; server_id?: string }): Promise<string> {
    const ctx = createRequestContext({ mcp_server_id: toolCall.server_id ?? this.serverId });
    await this.bus.publish('mcp.tool.call.requested', {
      correlation_id: ctx.correlation_id,
      session_id: ctx.session_id,
      phase: 'trust-gate',
      source: 'mcp-client',
      budget_tier: ctx.budget_tier,
      payload: toolCall,
    });
    return ctx.correlation_id;
  }

  /** Server info, available after initialize(). */
  getServerInfo(): ServerInfo | undefined {
    return this.serverInfo;
  }

  /** Cleanly close: rejects all pending requests with a shutdown error. */
  shutdown(): void {
    const err = new Error('McpClient shutdown');
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextRequestId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.transport.send(request);
    return promise;
  }

  private async runReceiveLoop(): Promise<void> {
    try {
      for await (const msg of this.transport.recv()) {
        // Responses have an id and result/error; correlate to pending.
        if ('id' in msg && msg.id !== null && 'jsonrpc' in msg && (('result' in msg) || ('error' in msg))) {
          const resp = msg as JsonRpcResponse;
          const pending = this.pending.get(resp.id as number | string);
          if (pending) {
            this.pending.delete(resp.id as number | string);
            pending.resolve(resp);
          }
          continue;
        }
        // Notifications (no id) — drop for v0.2; v0.3 will route to bus.
      }
    } catch (err) {
      // Transport closed unexpectedly — reject all pending.
      const e = err instanceof Error ? err : new Error(String(err));
      for (const { reject } of this.pending.values()) reject(e);
      this.pending.clear();
    }
  }
}

// Constant re-export so callers don't need the protocol module just for error codes.
export { JSONRPC_ERROR };
