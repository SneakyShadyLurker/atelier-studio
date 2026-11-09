// Cross-tab history channel. Every settled history write
// (HISTORY_WRITE_MUTATION_KEY, through the app's MutationCache), each accepted
// generation and a cancel's early signal post an invalidate here; every other
// tab of the same browser profile receives it and refetches its history, so
// sibling feeds converge without waiting for window focus. Cancel messages
// also let the tab that owns the SSE stream abort its local controller.
// Same-origin same-profile only; cross-device propagation is out of scope.
import { matchMutation, MutationCache } from '@tanstack/react-query';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

export const MY_TAB_ID = crypto.randomUUID();

interface InvalidateMessage {
  readonly type: 'invalidate';
  /** Informational: receivers refetch every history scope. Always a string,
      because bundles before the MutationCache broadcast drop any invalidate
      without one, and tabs of both bundles share the channel during a deploy. */
  readonly batchId: string;
}

interface CancelMessage {
  readonly type: 'cancel';
  readonly batchId: string;
  readonly originTabId: string;
}

type HistoryChannelMessage = InvalidateMessage | CancelMessage;

/**
 * BroadcastChannel is origin-partitioned, not user-partitioned. This channel
 * only carries opaque `{type, batchId, originTabId}` payloads today; if future
 * payloads include user-derived data, derive the channel name from Remote-User.
 * The SPA cannot read that Authelia-managed value yet, so plumb a userId
 * through first, for example via an nginx `sub_filter`-injected meta tag.
 */
const CHANNEL_NAME = 'atelier-history';

interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

function createChannel(): BroadcastChannelLike | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!Ctor) return null;
  return new Ctor(CHANNEL_NAME);
}

let channel: BroadcastChannelLike | null | undefined;
const noop = (): void => {
  return undefined;
};

function getChannel(): BroadcastChannelLike | null {
  if (channel === undefined) channel = createChannel();
  return channel;
}

export function emitHistoryInvalidate(batchId: string): void {
  const message: InvalidateMessage = { type: 'invalidate', batchId };
  getChannel()?.postMessage(message);
}

function batchIdOf(variables: unknown): string {
  return typeof variables === 'object' && variables !== null && 'batchId' in variables && typeof variables.batchId === 'string'
    ? variables.batchId
    : '';
}

/** The app's MutationCache: one owner that tells sibling tabs about every settled history write. */
export function createHistoryBroadcastMutationCache(): MutationCache {
  return new MutationCache({
    onSettled: (_data, _error, variables, _onMutateResult, mutation) => {
      if (matchMutation({ mutationKey: HISTORY_WRITE_MUTATION_KEY }, mutation)) emitHistoryInvalidate(batchIdOf(variables));
    },
  });
}

export function emitHistoryCancel(batchId: string, originTabId: string = MY_TAB_ID): void {
  const message: CancelMessage = { type: 'cancel', batchId, originTabId };
  getChannel()?.postMessage(message);
}

export function onHistoryInvalidate(handler: (batchId: string) => void): () => void {
  const ch = getChannel();
  if (!ch) return noop;
  const listener = (event: MessageEvent): void => {
    const data = event.data as Partial<HistoryChannelMessage> | undefined;
    if (data?.type === 'invalidate' && typeof data.batchId === 'string') {
      handler(data.batchId);
    }
  };
  ch.addEventListener('message', listener);
  return () => {
    ch.removeEventListener('message', listener);
  };
}

export function onHistoryCancel(handler: (batchId: string, originTabId: string) => void): () => void {
  const ch = getChannel();
  if (!ch) return noop;
  const listener = (event: MessageEvent): void => {
    const data = event.data as Partial<HistoryChannelMessage> | undefined;
    if (
      data?.type === 'cancel' &&
      typeof data.batchId === 'string' &&
      typeof data.originTabId === 'string'
    ) {
      handler(data.batchId, data.originTabId);
    }
  };
  ch.addEventListener('message', listener);
  return () => {
    ch.removeEventListener('message', listener);
  };
}

export function resetBroadcastForTests(): void {
  channel?.close();
  channel = undefined;
}
