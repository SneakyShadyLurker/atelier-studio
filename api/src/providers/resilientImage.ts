import type { IPolicy } from 'cockatiel';
import type { Pool } from '@atelier/shared';
import { TransientUpstreamError, policyBreakerState } from '../lifecycle/resilient-call';
import type { Provider, ProviderRequest, ProviderResult } from './types';

/** Minimal hook the decorator uses to report breaker transitions to the queue gate. */
export interface GateHook {
  noteBreakerState(pool: Pool, state: 'open' | 'half-open' | 'closed'): void;
}

export interface ResilientImageOptions {
  readonly modelId: string;
  readonly pool: Pool;
  readonly policy: IPolicy;
  readonly gate: GateHook;
}

type FailedResult = Extract<ProviderResult, { status: 'failed' }>;

interface Established {
  iterator: AsyncIterator<ProviderResult>;
  first: IteratorResult<ProviderResult>;
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

function statusOf(result: FailedResult): number | null {
  const err = result.error as { status?: unknown; reason?: { status?: unknown } } | null;
  if (err && typeof err === 'object') {
    if (typeof err.status === 'number') return err.status;
    if (err.reason && typeof err.reason === 'object' && typeof err.reason.status === 'number') return err.reason.status;
  }
  return null;
}

function isNetworkThrow(result: FailedResult): boolean {
  const err = result.error as { status?: unknown; cause?: unknown } | null;
  return !!err && typeof err === 'object' && err.status === null && 'cause' in err;
}

function isTransientFailure(result: FailedResult): boolean {
  const status = statusOf(result);
  if (status !== null && TRANSIENT_STATUSES.has(status)) return true;
  return isNetworkThrow(result);
}

function transientCategory(result: FailedResult): '429' | '5xx' {
  return statusOf(result) === 429 ? '429' : '5xx';
}

function stampServiceUnavailable(result: FailedResult): FailedResult {
  const status = statusOf(result) ?? 503;
  return {
    status: 'failed',
    seed: result.seed,
    index: result.index,
    error: { status, error: result.error, reason: { kind: 'service-unavailable', status, raw: 'service unavailable' } },
  };
}

export function resilientImageProvider(base: Provider, opts: ResilientImageOptions): Provider {
  const reportState = (): void => {
    opts.gate.noteBreakerState(opts.pool, policyBreakerState(opts.policy));
  };

  return {
    id: base.id,
    backend: base.backend,
    ...(base.healthCheck ? { healthCheck: base.healthCheck.bind(base) } : {}),
    async *generate(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderResult> {
      let established: Established;
      try {
        established = await opts.policy.execute<Established>(async () => {
          if (signal.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
          const iterator = base.generate(request, signal)[Symbol.asyncIterator]();
          const first = await iterator.next();
          if (!first.done && first.value.status === 'failed' && isTransientFailure(first.value)) {
            await iterator.return?.();
            throw new TransientUpstreamError(transientCategory(first.value), first.value);
          }
          return { iterator, first };
        }, signal);
      } catch (err) {
        reportState();
        if (err instanceof TransientUpstreamError) {
          const cause = err.cause;
          if (cause && typeof cause === 'object' && (cause as ProviderResult).status === 'failed') {
            yield stampServiceUnavailable(cause as FailedResult);
            return;
          }
        }
        throw err;
      }

      reportState();
      let childDone = established.first.done;
      try {
        if (!established.first.done) yield established.first.value;
        for (;;) {
          if (signal.aborted) return;
          const next = await established.iterator.next();
          if (next.done) {
            childDone = true;
            return;
          }
          yield next.value;
        }
      } finally {
        if (!childDone) await established.iterator.return?.();
      }
    },
  };
}
