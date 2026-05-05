/* tests/integration/trust-pin-digest-full.test.ts — verifies v0.4 follow-up #2.
   End-to-end through McpClient + Orchestrator: when a `transportDescriptor`
   is supplied, all six trust-pin fields participate in the digest. A change
   to ANY of cmd / binaryDigest / envAllowlist (in addition to the v0.3.2-
   covered args / url / schemaDigests) triggers a SecurityVetoError veto.

   Also verifies that a missing `binaryDigest` (e.g., file unreadable)
   doesn't throw — the digest just excludes that field per canonical-JSON
   omission, and the pin store can be re-approved with the same omission.
*/

import { describe, it, expect } from 'vitest';
import { McpClient } from '../../src/client/mcp-client.js';
import { SecurityVetoError } from '../../src/orchestration/lifecycle.js';
import {
  approveTrustPinUpdate,
  InMemoryTrustPinStore,
  type TrustPinInputs,
} from '../../src/registry/trust-pin.js';
import type { TransportDescriptor } from '../../src/transport/transport-descriptor.js';
import type { JsonRpcMessage, JsonRpcResponse } from '../../src/protocol/jsonrpc.js';

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

/** Fixed canned descriptor reused across the matched-pin path. */
function fixedDescriptor(overrides: Partial<{
  cmd: string;
  binaryDigest: string;
  envAllowlist: string[];
  args: string[];
}> = {}): TransportDescriptor {
  return {
    kind: 'stdio',
    cmd: overrides.cmd ?? '/usr/local/bin/mcp-fs',
    args: overrides.args ?? ['--root', '/srv'],
    binaryDigest: overrides.binaryDigest ?? 'a'.repeat(64),
    envAllowlist: overrides.envAllowlist ?? ['HOME', 'PATH'],
  };
}

describe('integration: trust-pin full digest (cmd / binaryDigest / envAllowlist)', () => {
  it('matched descriptor + matched call args → call passes through', async () => {
    const transport = makeTransport();
    const trustPinStore = new InMemoryTrustPinStore();
    const descriptor = fixedDescriptor();

    const client = new McpClient({
      serverId: 'fs',
      transport,
      trustPinStore,
      transportDescriptor: descriptor,
    });
    client.start();
    await client.listTools();

    // Seed the pin to the inputs the trust-gate hook will compute.
    const expected: TrustPinInputs = {
      args: ['echo', JSON.stringify({ text: 'hi' })],
      cmd: descriptor.cmd,
      binaryDigest: descriptor.binaryDigest,
      envAllowlist: descriptor.envAllowlist,
      schemaDigests: client.registry.schemaDigestsFor('fs'),
    };
    approveTrustPinUpdate(trustPinStore, 'fs', expected);

    const sentBefore = countToolsCalls(transport.sent);
    await client.callTool('echo', { text: 'hi' });
    expect(countToolsCalls(transport.sent)).toBe(sentBefore + 1);

    client.shutdown();
  });

  for (const field of ['cmd', 'binaryDigest', 'envAllowlist'] as const) {
    it(`mutated ${field} → SecurityVetoError, transport sees NO tools/call`, async () => {
      const transport = makeTransport();
      const trustPinStore = new InMemoryTrustPinStore();
      const pinnedDescriptor = fixedDescriptor();

      const client = new McpClient({
        serverId: 'fs',
        transport,
        trustPinStore,
        transportDescriptor:
          field === 'cmd'
            ? fixedDescriptor({ cmd: '/usr/local/bin/mcp-fs-EVIL' })
            : field === 'binaryDigest'
              ? fixedDescriptor({ binaryDigest: 'b'.repeat(64) })
              : fixedDescriptor({ envAllowlist: ['HOME', 'PATH', 'AWS_SECRET_ACCESS_KEY'] }),
      });
      client.start();
      await client.listTools();

      // Seed the store with the ORIGINAL (un-mutated) inputs.
      const pinned: TrustPinInputs = {
        args: ['echo', JSON.stringify({ text: 'hi' })],
        cmd: pinnedDescriptor.cmd,
        binaryDigest: pinnedDescriptor.binaryDigest,
        envAllowlist: pinnedDescriptor.envAllowlist,
        schemaDigests: client.registry.schemaDigestsFor('fs'),
      };
      approveTrustPinUpdate(trustPinStore, 'fs', pinned);

      const sentBefore = countToolsCalls(transport.sent);
      await expect(client.callTool('echo', { text: 'hi' })).rejects.toBeInstanceOf(SecurityVetoError);
      expect(countToolsCalls(transport.sent)).toBe(sentBefore);

      client.shutdown();
    });
  }

  it('descriptor without binaryDigest → digest omits the field; re-approval with same omission matches', async () => {
    const transport = makeTransport();
    const trustPinStore = new InMemoryTrustPinStore();

    const descriptor: TransportDescriptor = {
      kind: 'stdio',
      cmd: '/usr/local/bin/mcp-fs',
      args: ['--root', '/srv'],
      envAllowlist: ['HOME'],
      // binaryDigest intentionally omitted (file was unreadable / >64 MiB)
    };

    const client = new McpClient({
      serverId: 'fs',
      transport,
      trustPinStore,
      transportDescriptor: descriptor,
    });
    client.start();
    await client.listTools();

    // Pin with the SAME omission — no binaryDigest field at all.
    const expected: TrustPinInputs = {
      args: ['echo', JSON.stringify({ text: 'hi' })],
      cmd: descriptor.cmd,
      envAllowlist: descriptor.envAllowlist,
      schemaDigests: client.registry.schemaDigestsFor('fs'),
    };
    approveTrustPinUpdate(trustPinStore, 'fs', expected);

    // Should not throw; the digest is stable across the missing field.
    await expect(client.callTool('echo', { text: 'hi' })).resolves.toBeDefined();

    client.shutdown();
  });

  it('back-compat: no transportDescriptor → v0.3.2 behavior preserved (only args + schemas pin)', async () => {
    const transport = makeTransport();
    const trustPinStore = new InMemoryTrustPinStore();

    const client = new McpClient({
      serverId: 'fs',
      transport,
      trustPinStore,
      // no transportDescriptor
    });
    client.start();
    await client.listTools();

    const expected: TrustPinInputs = {
      args: ['echo', JSON.stringify({ text: 'hi' })],
      schemaDigests: client.registry.schemaDigestsFor('fs'),
    };
    approveTrustPinUpdate(trustPinStore, 'fs', expected);

    await expect(client.callTool('echo', { text: 'hi' })).resolves.toBeDefined();

    client.shutdown();
  });
});
