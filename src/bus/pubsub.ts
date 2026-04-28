/* enchanter/src/bus/pubsub.ts — implements architecture-spec
   phase_2 (event bus side of hybrid coordination) + phase_6.observability
   (event-stream tap). In-process pub-sub with bounded ring-buffer event store.
   Counter: external bus (NATS, Redis Streams) gives durability + multi-process
   replay; v1 in-process is chosen because we have no scale evidence yet —
   ADR-001 schedules the revisit at 100k requests/day. */

import { randomUUID } from 'node:crypto';
import type { EnchantedEvent, EventHandler, Subscription, PluginAck } from './event-types.js';
import type { LifecyclePhase } from '../orchestration/request-context.js';

const RING_BUFFER_DEFAULT_SIZE = 10_000;

/** Match a topic pattern. Supports `*` (any topic), `foo.*` prefix wildcard,
 *  or exact match. */
function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === '*') return true;
  if (pattern === topic) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // keeps the dot
    return topic.startsWith(prefix);
  }
  return false;
}

export interface AckTracker {
  /** Record an ack from a plugin for (correlation_id, phase). */
  ack(correlation_id: string, phase: LifecyclePhase, plugin: string, result: PluginAck): void;
  /** True if an ack already exists for (correlation_id, phase, plugin). */
  has(correlation_id: string, phase: LifecyclePhase, plugin: string): boolean;
  /** Wait until all named plugins ack or timeout fires. Returns map of plugin → ack. */
  waitForAcks(
    correlation_id: string,
    phase: LifecyclePhase,
    plugins: ReadonlyArray<string>,
    timeout_ms: number,
  ): Promise<Map<string, PluginAck>>;
}

class AckTrackerImpl implements AckTracker {
  // key = `${correlation_id}::${phase}::${plugin}`
  private readonly acks = new Map<string, PluginAck>();
  private readonly waiters = new Map<string, Array<() => void>>();

  ack(correlation_id: string, phase: LifecyclePhase, plugin: string, result: PluginAck): void {
    const key = this.keyFor(correlation_id, phase, plugin);
    this.acks.set(key, result);
    const ws = this.waiters.get(key);
    if (ws) {
      this.waiters.delete(key);
      for (const w of ws) w();
    }
  }

  has(correlation_id: string, phase: LifecyclePhase, plugin: string): boolean {
    return this.acks.has(this.keyFor(correlation_id, phase, plugin));
  }

  async waitForAcks(
    correlation_id: string,
    phase: LifecyclePhase,
    plugins: ReadonlyArray<string>,
    timeout_ms: number,
  ): Promise<Map<string, PluginAck>> {
    const deadline = Date.now() + timeout_ms;
    const result = new Map<string, PluginAck>();
    const pending = new Set<string>();
    for (const p of plugins) {
      const key = this.keyFor(correlation_id, phase, p);
      const existing = this.acks.get(key);
      if (existing) result.set(p, existing);
      else pending.add(p);
    }
    if (pending.size === 0) return result;

    await new Promise<void>((resolve) => {
      const onAck = (): void => {
        // Past-deadline check: if the deadline has already passed, resolve
        // with whatever acks we have. The variable is the elapsed time
        // PAST the deadline (negative when not yet expired).
        const elapsedPastDeadline = Date.now() - deadline;
        if (elapsedPastDeadline > 0) return resolve();
        for (const p of pending) {
          const key = this.keyFor(correlation_id, phase, p);
          const a = this.acks.get(key);
          if (a) {
            result.set(p, a);
            pending.delete(p);
          }
        }
        if (pending.size === 0) resolve();
      };
      for (const p of pending) {
        const key = this.keyFor(correlation_id, phase, p);
        const ws = this.waiters.get(key) ?? [];
        ws.push(onAck);
        this.waiters.set(key, ws);
      }
      const timeRemaining = deadline - Date.now();
      if (timeRemaining > 0) {
        setTimeout(() => resolve(), timeRemaining).unref?.();
      } else {
        resolve();
      }
    });
    return result;
  }

  private keyFor(correlation_id: string, phase: LifecyclePhase, plugin: string): string {
    return `${correlation_id}::${phase}::${plugin}`;
  }
}

export interface Bus {
  publish(topic: string, event: Omit<EnchantedEvent, 'id' | 'topic' | 'ts'> & { topic?: string }): Promise<void>;
  subscribe(topic: string, handler: EventHandler): Subscription;
  /** Read the in-memory ring buffer, optionally filtered by correlation_id. */
  tap(correlation_id?: string): EnchantedEvent[];
  readonly acks: AckTracker;
}

export class InProcessBus implements Bus {
  private readonly subscriptions = new Map<string, Set<EventHandler>>();
  private readonly buffer: EnchantedEvent[] = [];
  private readonly bufferMax: number;
  public readonly acks: AckTracker = new AckTrackerImpl();

  constructor(bufferMax: number = RING_BUFFER_DEFAULT_SIZE) {
    this.bufferMax = bufferMax;
  }

  async publish(
    topic: string,
    partial: Omit<EnchantedEvent, 'id' | 'topic' | 'ts'> & { topic?: string },
  ): Promise<void> {
    const event: EnchantedEvent = {
      id: randomUUID(),
      topic: partial.topic ?? topic,
      ts: Date.now(),
      correlation_id: partial.correlation_id,
      session_id: partial.session_id,
      phase: partial.phase,
      source: partial.source,
      budget_tier: partial.budget_tier,
      payload: partial.payload,
    };

    // Append to ring buffer (drop oldest)
    this.buffer.push(event);
    if (this.buffer.length > this.bufferMax) this.buffer.shift();

    // Dispatch to matching subscriptions
    const matched: EventHandler[] = [];
    for (const [pattern, handlers] of this.subscriptions) {
      if (topicMatches(pattern, topic)) {
        for (const h of handlers) matched.push(h);
      }
    }

    // Run handlers; collect derived events to publish after this dispatch.
    const derived: EnchantedEvent[] = [];
    await Promise.all(
      matched.map(async (h) => {
        try {
          const out = await h(event);
          if (Array.isArray(out)) for (const e of out) derived.push(e);
        } catch {
          // Subscriber failures are isolated by design — bus does not crash.
          // (Audit log captures elsewhere.)
        }
      }),
    );

    for (const e of derived) await this.publish(e.topic, e);
  }

  subscribe(topic: string, handler: EventHandler): Subscription {
    const set = this.subscriptions.get(topic) ?? new Set<EventHandler>();
    set.add(handler);
    this.subscriptions.set(topic, set);
    return {
      topic,
      handler,
      unsubscribe: () => {
        const s = this.subscriptions.get(topic);
        if (s) {
          s.delete(handler);
          if (s.size === 0) this.subscriptions.delete(topic);
        }
      },
    };
  }

  tap(correlation_id?: string): EnchantedEvent[] {
    if (!correlation_id) return [...this.buffer];
    return this.buffer.filter((e) => e.correlation_id === correlation_id);
  }
}
