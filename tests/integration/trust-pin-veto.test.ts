/* tests/integration/trust-pin-veto.test.ts — verifies v0.3.2 wire-up of
   `enforceTrustPin` into the orchestrator's trust-gate phase.

   Covers (end-to-end through McpClient + Orchestrator):
     1. matching inputs after pin → tool call succeeds, transport sees the call
     2. mutated inputs after pin → SecurityVetoError, transport sees NO call,
        bus emits `hydra.trust-pin.mismatch`
     3. back-compat: undefined trustPinStore → no enforcement, no behavioral
        change vs pre-v0.3.2
*/

import { describe, it, expect } from 'vitest';
import { McpClient } from '../../src/client/mcp-client.js';
import { SecurityVetoError } from '../../src/orchestration/lifecycle.js';
import {
  approveTrustPinUpdate,
  computeTrustDigest,
  InMemoryTrustPinStore,
  type TrustPinInputs,
} from '../../src/registry/trust-pin.js';
import type { JsonRpcMessage, JsonRpcResponse } from '../../src/protocol/jsonrpc.js';

// ---------------------------------------------------------------------------
// In-memory transport fixture — records every send, scripts canned responses.
// Lets the test assert "request never reached the wire" by reading sent[].
// ---------------------------------------------------------------------------

interface ScriptedTransport {
  send(msg: JsonRpcMessage): Promise<void>;
  recv(): AsyncIterableIterator<JsonRpcMessage>;
  readonly sent: JsonRpcMessage[];
}

function makeTransport(): ScriptedTransport {
  const sent: JsonRpcMessage[] = [];
  const inbox: JsonRpcMessage[] = [];
  let resolveNext: ((m: JsonRpcMessage) => void) | undefined;

  const push = (m: JsonRpcMessage): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = undefined;
      r(m);
    } else {
      inbox.push(m);
    }
  };

  return {
    sent,
    async send(msg: JsonRpcMessage): Promise<void> {
      sent.push(msg);
      // Auto-respond to tools/list and tools/call so the test does not need
      // a real subprocess; tools/list returns one tool, tools/call echoes args.
      if ('method' in msg && msg.method === 'tools/list' && 'id' in msg) {
        const resp: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: msg.id!,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echoes the input.',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              },
            ],
          },
        };
        push(resp);
      } else if ('method' in msg && msg.method === 'tools/call' && 'id' in msg) {
        const resp: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: msg.id!,
          result: { content: [{ type: 'text', text: 'ok' }] },
        };
        push(resp);
      }
    },
    recv(): AsyncIterableIterator<JsonRpcMessage> {
      return {
        [Symbol.asyncIterator](): AsyncIterableIterator<JsonRpcMessage> {
          return this;
        },
        async next(): Promise<IteratorResult<JsonRpcMessage>> {
          if (inbox.length > 0) {
            return { value: inbox.shift()!, done: false };
          }
          const msg = await new Promise<JsonRpcMessage>((res) => {
            resolveNext = res;
          });
          return { value: msg, done: false };
        },
        async return(): Promise<IteratorResult<JsonRpcMessage>> {
          return { value: undefined as unknown as JsonRpcMessage, done: true };
        },
      };
    },
  };
}

function countToolsCalls(sent: JsonRpcMessage[]): number {
  return sent.filter((m) => 'method' in m && m.method === 'tools/call').length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('integration: trust-pin enforcement at trust-gate phase', () => {
  it('matching inputs after pin → tool call succeeds, transport sees the call', async () => {
    const transport = makeTransport();
    const trustPinStore = new InMemoryTrustPinStore();

    const client = new McpClient({ serverId: 'fs', transport, trustPinStore });
    client.start();
    await client.listTools();

    // Seed the pin with the SAME inputs McpClient will compute at call time:
    //   args = [bare_name, JSON.stringify(args)] ; schemaDigests sorted.
    const expectedInputs: TrustPinInputs = {
      args: ['echo', JSON.stringify({ text: 'hi' })],
      schemaDigests: client.registry.schemaDigestsFor('fs'),
    };
    approveTrustPinUpdate(trustPinStore, 'fs', expectedInputs);

    const sentBefore = countToolsCalls(transport.sent);
    const result = await client.callTool('echo', { text: 'hi' });
    expect(result).toBeDefined();
    expect(countToolsCalls(transport.sent)).toBe(sentBefore + 1);

    client.shutdown();
  });

  it('mutated inputs after pin → SecurityVetoError, transport sees NO tools/call, bus emits mismatch', async () => {
    const transport = makeTransport();
    const trustPinStore = new InMemoryTrustPinStore();

    const client = new McpClient({ serverId: 'fs', transport, trustPinStore });
    client.start();
    await client.listTools();

    // Seed the pin with one set of inputs; then call with mutated args.
    const pinnedInputs: TrustPinInputs = {
      args: ['echo', JSON.stringify({ text: 'pinned' })],
      schemaDigests: client.registry.schemaDigestsFor('fs'),
    };
    approveTrustPinUpdate(trustPinStore, 'fs', pinnedInputs);

    // Capture bus emissions on the trust-pin mismatch topic.
    const mismatchEvents: unknown[] = [];
    client.bus.subscribe('hydra.trust-pin.mismatch', (e) => {
      mismatchEvents.push(e);
    });

    const sentBefore = countToolsCalls(transport.sent);
    await expect(client.callTool('echo', { text: 'mutated' })).rejects.toBeInstanceOf(SecurityVetoError);

    // Critical: the request must NOT have reached the wire.
    expect(countToolsCalls(transport.sent)).toBe(sentBefore);

    // And the bus must have published the mismatch event.
    expect(mismatchEvents).toHaveLength(1);
    const ev = mismatchEvents[0] as { topic: string; payload: Record<string, unknown> };
    expect(ev.topic).toBe('hydra.trust-pin.mismatch');
    expect(ev.payload['server_id']).toBe('fs');
    expect(ev.payload['pinned_digest']).toBe(computeTrustDigest(pinnedInputs));

    client.shutdown();
  });

  it('back-compat: undefined trustPinStore → no enforcement, call passes through', async () => {
    const transport = makeTransport();
    // No trustPinStore configured.
    const client = new McpClient({ serverId: 'fs', transport });
    client.start();
    await client.listTools();

    const sentBefore = countToolsCalls(transport.sent);
    await client.callTool('echo', { text: 'whatever' });
    expect(countToolsCalls(transport.sent)).toBe(sentBefore + 1);

    client.shutdown();
  });
});
