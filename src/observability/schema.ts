/* src/observability/schema.ts — minimal JSON Schema validator for the
 * Enchanter event-bus wire format.
 *
 * Loads docs/event-schema.json at module init and exposes:
 *   - validate(event):    inbound event (Bridge.enqueue → JSONL line)
 *   - validateCommand(c): outbound control command (TcpControlSink → runtime)
 *
 * NOT a full draft 2020-12 implementation. Hand-rolled walker that supports
 * exactly the keywords our schema uses: type, properties, required, oneOf,
 * enum, const, minimum, $ref, additionalProperties. Intentionally tight so
 * "no new top-level dep" is achievable.
 *
 * Failure shape is shared across both sides of the wire — the TS validator
 * and the Rust validator return the same { ok | reason | path } structure
 * so error messages read consistently in mixed-language logs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; path: string[] };

type SchemaNode = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Schema load — resolved relative to this source file so packaged dist works
// ---------------------------------------------------------------------------

function loadSchema(): SchemaNode {
  // import.meta.url points at .ts in dev (tsx/vitest) and .js in dist.
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    // src layout: src/observability/ -> ../../docs/event-schema.json
    path.resolve(path.dirname(here), '..', '..', 'docs', 'event-schema.json'),
    // dist layout: dist/observability/ -> ../../docs/event-schema.json (also valid)
    path.resolve(path.dirname(here), '..', '..', 'docs', 'event-schema.json'),
  ];
  for (const candidate of candidates) {
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      return JSON.parse(text) as SchemaNode;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `[schema] event-schema.json not found; searched: ${candidates.join(', ')}`,
  );
}

const SCHEMA = loadSchema();
const DEFINITIONS = (SCHEMA.definitions as Record<string, SchemaNode> | undefined) ?? {};

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

function deref(node: SchemaNode): SchemaNode {
  const ref = node.$ref;
  if (typeof ref !== 'string') return node;
  // We only support the form "#/definitions/<name>".
  const m = /^#\/definitions\/([^/]+)$/.exec(ref);
  if (!m) return node;
  const name = m[1];
  if (name === undefined) return node;
  const target = DEFINITIONS[name];
  return target ?? node;
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(declared: string, actual: string): boolean {
  if (declared === 'integer') return actual === 'number';
  return declared === actual;
}

function fail(reason: string, path: string[]): ValidationResult {
  return { ok: false, reason, path };
}

/** Heuristic: does this branch's `type` discriminator (a const or an enum on
 *  the `type` property) match the `type` field of the candidate object?
 *  Used when surfacing oneOf failures so the most-relevant branch's reason
 *  wins over an unrelated branch's `const` mismatch. */
function branchTypeMatches(branch: SchemaNode, value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const t = obj.type;
  if (typeof t !== 'string') return false;
  const properties = branch.properties as Record<string, SchemaNode> | undefined;
  if (!properties) return false;
  const typeSchema = properties.type;
  if (!typeSchema) return false;
  if (Object.prototype.hasOwnProperty.call(typeSchema, 'const')) {
    return typeSchema.const === t;
  }
  if (Array.isArray(typeSchema.enum)) {
    return typeSchema.enum.includes(t as never);
  }
  return false;
}

function ok(): ValidationResult {
  return { ok: true };
}

function check(node: SchemaNode, value: unknown, path: string[]): ValidationResult {
  const schema = deref(node);

  // const
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (value !== schema.const) {
      return fail(`expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`, path);
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value as never)) {
      return fail(`value ${JSON.stringify(value)} not in enum`, path);
    }
  }

  // type
  if (typeof schema.type === 'string') {
    const actual = jsonType(value);
    if (!typeMatches(schema.type, actual)) {
      return fail(`expected type ${schema.type}, got ${actual}`, path);
    }
  }

  // minimum (numbers only)
  if (typeof schema.minimum === 'number' && typeof value === 'number') {
    if (value < schema.minimum) {
      return fail(`value ${value} below minimum ${schema.minimum}`, path);
    }
  }

  // object structure
  if (jsonType(value) === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;

    // required
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key !== 'string') continue;
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
          return fail(`missing required field "${key}"`, path);
        }
      }
    }

    // properties
    const properties = schema.properties as Record<string, SchemaNode> | undefined;
    if (properties) {
      for (const [key, subSchema] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const result = check(subSchema, obj[key], [...path, key]);
          if (!result.ok) return result;
        }
      }
    }

    // additionalProperties: only enforce when explicitly false. Our schema
    // sets additionalProperties:true everywhere top-level, so this is mostly
    // a guard for future tightening.
    if (schema.additionalProperties === false && properties) {
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          return fail(`unexpected field "${key}"`, path);
        }
      }
    }
  }

  // oneOf — first match wins. If none match, prefer the failure from the
  // branch whose `type` discriminator (const or enum) matched the input —
  // that's the branch the producer "intended" to satisfy. Otherwise fall
  // back to the deepest-path failure.
  if (Array.isArray(schema.oneOf)) {
    let bestFail: ValidationResult | null = null;
    let bestIntended = false;
    for (const branch of schema.oneOf) {
      const result = check(branch as SchemaNode, value, path);
      if (result.ok) return ok();
      const intended = branchTypeMatches(deref(branch as SchemaNode), value);
      const replace =
        bestFail === null ||
        (intended && !bestIntended) ||
        (intended === bestIntended &&
          !bestFail.ok &&
          !result.ok &&
          result.path.length > bestFail.path.length);
      if (replace) {
        bestFail = result;
        bestIntended = intended;
      }
    }
    if (bestFail !== null) return bestFail;
    return fail('no oneOf branch matched', path);
  }

  return ok();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Validate an inbound event (the JSONL shape Bridge.enqueue is about to
 *  serialize). Returns ok:false with a path when invalid. */
export function validate(event: unknown): ValidationResult {
  if (jsonType(event) !== 'object' || event === null) {
    return fail(`expected object, got ${jsonType(event)}`, []);
  }
  return check(SCHEMA, event, []);
}

/** Validate an outbound control command — separate top-level oneOf at
 *  schema.outboundCommands. Used by control-channel emitters. */
export function validateCommand(command: unknown): ValidationResult {
  const out = SCHEMA.outboundCommands as SchemaNode | undefined;
  if (out === undefined) return fail('outboundCommands schema missing', []);
  if (jsonType(command) !== 'object' || command === null) {
    return fail(`expected object, got ${jsonType(command)}`, []);
  }
  return check(out, command, []);
}

/** Re-export the loaded schema for callers (tests, tooling). Not for mutation. */
export function schema(): SchemaNode {
  return SCHEMA;
}
