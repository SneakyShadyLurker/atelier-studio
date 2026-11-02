import type { TerminalFrame } from '../lifecycle/sse';

export interface Sink {
  enqueueTerminal(frame: TerminalFrame): void;
  // Lazy: the frame is only materialized if this sink will actually enqueue it
  // (open + has buffer space). Lets the producer skip an expensive
  // serialization (e.g. a ~1 MB base64 partial-preview frame) on a saturated
  // or absent consumer.
  enqueueOptional(makeFrame: () => Uint8Array): void;
  close?(): void;
}

interface SubscribeOptions {
  replayBuffered?: boolean;
}

const subscriptions = new Map<string, Set<Sink>>();
const terminalBuffer = new Map<string, TerminalFrame[]>();
const TERMINAL_BUFFER_LIMIT = 64;
let nextSubscribeFailureForTests: unknown;

export function subscribe(batchId: string, sink: Sink, options: SubscribeOptions = {}): () => void {
  if (nextSubscribeFailureForTests !== undefined) {
    const failure = nextSubscribeFailureForTests;
    nextSubscribeFailureForTests = undefined;
    throw failure instanceof Error ? failure : new Error('subscribe replay test failure');
  }
  const buffered = terminalBuffer.get(batchId);
  if (options.replayBuffered !== false && buffered) {
    for (const frame of buffered) sink.enqueueTerminal(frame);
  }
  let sinks = subscriptions.get(batchId);
  if (!sinks) {
    sinks = new Set();
    subscriptions.set(batchId, sinks);
  }
  sinks.add(sink);

  return () => {
    const current = subscriptions.get(batchId);
    if (!current) return;
    current.delete(sink);
    if (current.size === 0) subscriptions.delete(batchId);
  };
}

export function broadcastTerminal(batchId: string, frame: TerminalFrame): void {
  const next = [...(terminalBuffer.get(batchId) ?? []), frame];
  terminalBuffer.set(batchId, next.slice(-TERMINAL_BUFFER_LIMIT));
  const sinks = subscriptions.get(batchId);
  if (!sinks) return;
  for (const sink of [...sinks]) sink.enqueueTerminal(frame);
}

export function broadcastOptional(batchId: string, makeFrame: () => Uint8Array): void {
  const sinks = subscriptions.get(batchId);
  if (!sinks) return;
  // Materialize at most once across all sinks, and only if some sink actually
  // wants it — no subscriber (handled above) or every subscriber saturated
  // means the factory never runs.
  let cached: Uint8Array | undefined;
  const once = (): Uint8Array => (cached ??= makeFrame());
  for (const sink of [...sinks]) sink.enqueueOptional(once);
}

export function closeBatch(batchId: string): void {
  const sinks = subscriptions.get(batchId);
  if (sinks) {
    for (const sink of sinks) {
      try {
        sink.close?.();
      } catch {
        // Best-effort sink close; cleanup below is the invariant.
      }
    }
  }
  subscriptions.delete(batchId);
  terminalBuffer.delete(batchId);
}

export function resetForTests(): void {
  subscriptions.clear();
  terminalBuffer.clear();
  nextSubscribeFailureForTests = undefined;
}

export function failNextSubscribeForTests(error: unknown): void {
  nextSubscribeFailureForTests = error;
}
