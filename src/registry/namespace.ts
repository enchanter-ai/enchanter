/* enchanter/src/registry/namespace.ts — implements architecture-spec
   phase_4 failure-mode 1 (tool-name collisions): host namespace registry
   rejects bare-name resolution when 2+ servers export the same name; requires
   qualified `server_id.tool_name` resolution. Schema digest is pinned at
   first registration (defense-in-depth on failure-mode 10 MCPoison fix:
   schema-mutation triggers re-consent).
   Counter: trusting bare names "first-write-wins" would be simpler operationally
   but invites the documented attack — we reject explicitly. */

import { createHash } from 'node:crypto';

export interface ToolIdentity {
  readonly server_id: string;
  readonly bare_name: string;
  /** SHA-256 of the canonicalized tool schema (description + input schema + output schema). */
  readonly schema_digest: string;
}

export class ToolNameCollisionError extends Error {
  constructor(
    public readonly bare_name: string,
    public readonly servers: ReadonlyArray<string>,
  ) {
    super(
      `tool name "${bare_name}" exported by multiple servers (${servers.join(', ')}); use qualified "server_id.tool_name"`,
    );
    this.name = 'ToolNameCollisionError';
  }
}

export class ToolNotFoundError extends Error {
  constructor(public readonly query: string) {
    super(`tool not found: ${query}`);
    this.name = 'ToolNotFoundError';
  }
}

export class SchemaDigestMismatchError extends Error {
  constructor(
    public readonly tool: string,
    public readonly pinned: string,
    public readonly seen: string,
  ) {
    super(`tool ${tool} schema digest changed: pinned=${pinned} seen=${seen} — requires re-consent`);
    this.name = 'SchemaDigestMismatchError';
  }
}

export interface ToolSchema {
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export class NamespaceRegistry {
  // qualified `server_id.tool_name` → ToolIdentity
  private readonly byQualified = new Map<string, ToolIdentity>();
  // bare name → set of server_ids that export it
  private readonly byBare = new Map<string, Set<string>>();

  register(server_id: string, bare_name: string, schema: ToolSchema): ToolIdentity {
    const qualified = this.qualify(server_id, bare_name);
    const schema_digest = computeSchemaDigest(schema);

    const existing = this.byQualified.get(qualified);
    if (existing && existing.schema_digest !== schema_digest) {
      throw new SchemaDigestMismatchError(qualified, existing.schema_digest, schema_digest);
    }

    const identity: ToolIdentity = { server_id, bare_name, schema_digest };
    this.byQualified.set(qualified, identity);

    const servers = this.byBare.get(bare_name) ?? new Set<string>();
    servers.add(server_id);
    this.byBare.set(bare_name, servers);

    return identity;
  }

  /**
   * Resolve a tool name to its identity.
   * - Try `query` as a qualified `server_id.tool_name` first. (Tools whose
   *   bare names contain dots — e.g., `shell.exec` from Cline — would
   *   otherwise be misclassified as qualified.)
   * - Fall back to bare-name lookup if not found.
   * - If bare and ambiguous (multiple servers expose the same name), throw
   *   ToolNameCollisionError.
   */
  resolve(query: string): ToolIdentity {
    const qualifiedHit = this.byQualified.get(query);
    if (qualifiedHit) return qualifiedHit;

    const servers = this.byBare.get(query);
    if (!servers || servers.size === 0) throw new ToolNotFoundError(query);
    if (servers.size > 1) {
      throw new ToolNameCollisionError(query, [...servers].sort());
    }
    const server_id = [...servers][0]!;
    const ident = this.byQualified.get(this.qualify(server_id, query));
    if (!ident) throw new ToolNotFoundError(query);
    return ident;
  }

  /**
   * Return the sorted list of schema digests for every tool registered under
   * `server_id`. Used by the trust-pin enforcement path so a per-server
   * digest-set change (added/dropped/mutated tool) flips the trust-pin.
   */
  schemaDigestsFor(server_id: string): string[] {
    const prefix = `${server_id}.`;
    const out: string[] = [];
    for (const [qualified, ident] of this.byQualified) {
      if (qualified.startsWith(prefix)) out.push(ident.schema_digest);
    }
    return out.sort();
  }

  unregister(server_id: string, bare_name: string): void {
    const qualified = this.qualify(server_id, bare_name);
    this.byQualified.delete(qualified);
    const servers = this.byBare.get(bare_name);
    if (servers) {
      servers.delete(server_id);
      if (servers.size === 0) this.byBare.delete(bare_name);
    }
  }

  unregisterServer(server_id: string): void {
    const prefix = `${server_id}.`;
    for (const qualified of [...this.byQualified.keys()]) {
      if (qualified.startsWith(prefix)) {
        const ident = this.byQualified.get(qualified)!;
        this.unregister(server_id, ident.bare_name);
      }
    }
  }

  private qualify(server_id: string, bare_name: string): string {
    return `${server_id}.${bare_name}`;
  }
}

export function computeSchemaDigest(schema: ToolSchema): string {
  // Canonicalize via JSON.stringify with sorted keys for deterministic hashing.
  const canonical = JSON.stringify(schema, Object.keys(schema).sort());
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
