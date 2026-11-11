import {
  BrokenCircuitError,
  circuitBreaker,
  CircuitState,
  ConsecutiveBreaker,
  DelegateBackoff,
  ExponentialBackoff,
  handleWhen,
  NoopPolicy,
  retry,
  TaskCancelledError,
  timeout,
  TimeoutStrategy,
  type IBackoff,
  wrap,
  type IPolicy,
  type IRetryBackoffContext,
} from 'cockatiel';
import { abortReason, isAbortError } from './abort';

// Shared resilience primitives for upstream LLM calls (CLIProxyAPI text path).
// Owns: typed error taxonomy, retriability predicates, policy construction,
// and breaker-state inspection.

export type TransientCategory =
  | '5xx'
  | '429'
  | '408'
  | 'socket'
  | 'in-stream-timeout'
  | 'timeout';

export class TransientUpstreamError extends Error {
  override readonly name = 'TransientUpstreamError';

  constructor(
    readonly category: TransientCategory,
    override readonly cause: unknown,
    message?: string,
  ) {
    super(message ?? `transient upstream: ${category}`);
  }
}

export type PermanentCategory = '4xx' | 'in-stream';

export class PermanentUpstreamError extends Error {
  override readonly name = 'PermanentUpstreamError';

  constructor(
    readonly category: PermanentCategory,
    override readonly cause: unknown,
    message?: string,
  ) {
    super(message ?? `permanent upstream: ${category}`);
  }
}

// The caller's own signal aborted while an attempt was in flight. Raised by the
// guard layer inside the breaker in place of whatever the attempt rejected
// with, so a client disconnect or route deadline is never mistaken for an
// upstream failure. The signal's reason is kept as `cause` and not rethrown: a
// reason from `AbortSignal.timeout` is a TimeoutError, which `isRetriable`
// would treat as an upstream timeout.
export class CallerAbortedError extends Error {
  override readonly name = 'CallerAbortedError';

  constructor(
    override readonly cause: unknown,
    /** The aborted attempt was a breaker's half-open trial. */
    readonly duringTrial = false,
  ) {
    super('caller aborted');
  }
}

export class QuotaExhaustedError extends Error {
  override readonly name = 'QuotaExhaustedError';
  constructor(
    readonly retryAfterSeconds: number | null,
    override readonly cause: unknown,
    message?: string,
  ) {
    super(message ?? 'upstream quota exhausted');
  }
}

export function isRetriable(err: unknown): boolean {
  if (err instanceof CallerAbortedError) return false;
  if (isAbortError(err)) return false;
  if (isTimeoutErrorLike(err)) return true;
  if (err instanceof BrokenCircuitError) return false;
  if (err instanceof TaskCancelledError) return true;
  if (err instanceof QuotaExhaustedError) return false;
  if (err instanceof TransientUpstreamError) return true;
  return false;
}

export interface ResilientPolicyOptions {
  readonly timeoutPerAttemptMs: number;
  /** Total invocations including the initial call. */
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly breakerThreshold: number;
  readonly halfOpenAfterMs: number;
  readonly noTimeout?: boolean;
  /** When true, place the breaker OUTSIDE retry: wrap(breaker, retry[, timeout]).
   *  The breaker then counts one failure per fully-exhausted execute (one tile that
   *  gave up), not per attempt. Default false preserves the existing composition order
   *  (breaker inside retry, used by the text/LLM path). */
  readonly breakerOutsideRetry?: boolean;
  /** Minimum retry delay for a 429, in ms. Defaults to RATE_LIMIT_BACKOFF_FLOOR_MS.
   *  Honored Retry-After values below this floor are raised to it so a rate-limited
   *  upstream is never retried faster than the floor. Injectable for fast tests. */
  readonly rateLimitBackoffFloorMs?: number;
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

const RATE_LIMIT_BACKOFF_FLOOR_MS = 5_000;
const RETRY_AFTER_BACKOFF_CEILING_MS = 60_000;

interface RetryBackoffState {
  readonly exponential: IBackoff<unknown>;
}

export function buildResilientPolicy(opts: ResilientPolicyOptions): IPolicy {
  const exponentialBackoff = new ExponentialBackoff({
    initialDelay: opts.initialBackoffMs,
    maxDelay: opts.maxBackoffMs,
  });
  const retryPolicy = retry(handleWhen(isRetriable), {
    maxAttempts: Math.max(0, opts.maxAttempts - 1),
    backoff: new DelegateBackoff<IRetryBackoffContext<unknown>, RetryBackoffState>((context, state) => {
      const next = nextExponentialBackoff(exponentialBackoff, state);
      const failure = failureReasonValue(context);
      const rateLimited = isRateLimitFailure(failure);
      const floorMs = opts.rateLimitBackoffFloorMs ?? RATE_LIMIT_BACKOFF_FLOOR_MS;
      const retryAfterMs = retryAfterMsOf(failure);
      let delay: number;
      if (retryAfterMs !== null) {
        // Honor upstream Retry-After, but never hold a concurrency-pool slot
        // beyond the normal backoff envelope (cap at maxBackoffMs), and never
        // retry a 429 below the floor (a 0 / past-date / sub-floor header must
        // not let a rate-limited upstream be hammered).
        delay = Math.min(retryAfterMs, opts.maxBackoffMs);
        if (rateLimited) delay = Math.max(delay, floorMs);
      } else {
        delay = rateLimited ? Math.max(next.delay, floorMs) : next.delay;
      }
      return { delay, state: next.state };
    }),
  });
  if (opts.onRetry) {
    retryPolicy.onRetry((evt) => {
      opts.onRetry?.(evt.attempt, 'error' in evt ? evt.error : evt.value);
    });
  }

  // A caller abort is not upstream evidence. An attempt that entered while
  // the breaker was closed leaves it unhandled, so it never counts toward
  // opening; an aborted half-open trial is handled, because cockatiel treats
  // an unhandled trial error as success and would close the circuit with no
  // proof the upstream recovered. The decision uses the state this breaker
  // execution started in (`duringTrial`, set by `trialOwnership`), not the
  // live state: an older call that aborts while a newer trial is running must
  // not re-open the circuit under it.
  const breakerPolicy = circuitBreaker(
    handleWhen((err) => isRetriable(err) || (err instanceof CallerAbortedError && err.duringTrial)),
    {
      halfOpenAfter: opts.halfOpenAfterMs,
      breaker: new ConsecutiveBreaker(opts.breakerThreshold),
    },
  );

  const attempt = callerAbortGuard(
    opts.noTimeout ? new NoopPolicy() : timeout(opts.timeoutPerAttemptMs, TimeoutStrategy.Aggressive),
  );
  // Sits directly inside the breaker, so it samples the state once per breaker
  // execution and before any inner retry. cockatiel moves to HalfOpen before
  // it invokes the trial and admits no other execution while the trial is in
  // flight, so an execution that enters in HalfOpen is the trial. Sampling per
  // attempt would be wrong with the breaker outside retry: an older
  // execution's retry can start while a newer trial is running.
  const ownership = trialOwnership(() => breakerPolicy.state === CircuitState.HalfOpen);
  const policy = opts.breakerOutsideRetry
    ? wrap(breakerPolicy, ownership, retryPolicy, attempt)
    : wrap(retryPolicy, breakerPolicy, ownership, attempt);

  return abortablePolicy(policy);
}

// Runs one attempt through `inner` (the per-attempt timeout, or a no-op) and
// turns any rejection that happens while the execution signal is aborted into
// a CallerAbortedError. Without it the Aggressive timeout reports a caller
// abort as its own TaskCancelledError, which the breaker counts as a failure.
// A genuine per-attempt timeout leaves the caller signal untouched and passes
// through unchanged.
function callerAbortGuard(inner: IPolicy): IPolicy {
  return {
    _altReturn: undefined,
    onFailure: inner.onFailure,
    onSuccess: inner.onSuccess,
    async execute<T>(fn: (context: { signal: AbortSignal }) => PromiseLike<T> | T, signal?: AbortSignal) {
      try {
        return await inner.execute(fn, signal);
      } catch (err) {
        if (signal?.aborted) throw new CallerAbortedError(signal.reason);
        throw err;
      }
    },
  } as IPolicy;
}

// Marks a caller abort as belonging to the breaker's half-open trial when the
// execution it wraps entered the breaker as that trial.
function trialOwnership(isTrial: () => boolean): IPolicy {
  const passthrough = new NoopPolicy();
  return {
    _altReturn: undefined,
    onFailure: passthrough.onFailure,
    onSuccess: passthrough.onSuccess,
    async execute<T>(fn: (context: { signal: AbortSignal }) => PromiseLike<T> | T, signal?: AbortSignal) {
      const ownsTrial = isTrial();
      try {
        return await passthrough.execute(fn, signal);
      } catch (err) {
        if (ownsTrial && err instanceof CallerAbortedError) throw new CallerAbortedError(err.cause, true);
        throw err;
      }
    },
  } as IPolicy;
}

function nextExponentialBackoff(
  exponentialBackoff: ExponentialBackoff<unknown>,
  state: RetryBackoffState | undefined,
): { delay: number; state: RetryBackoffState } {
  const exponential = state?.exponential.next(undefined) ?? exponentialBackoff.next();
  return { delay: exponential.duration, state: { exponential } };
}

function failureReasonValue(context: IRetryBackoffContext<unknown>): unknown {
  return 'error' in context.result ? context.result.error : context.result.value;
}

function isRateLimitFailure(failure: unknown): boolean {
  return failure instanceof TransientUpstreamError && failure.category === '429';
}

function retryAfterMsOf(failure: unknown): number | null {
  if (failure instanceof TransientUpstreamError) {
    return retryAfterMsFromUnknown(failure.cause);
  }
  return retryAfterMsFromUnknown(failure);
}

function retryAfterMsFromUnknown(value: unknown, depth = 0): number | null {
  if (depth > 3 || value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const retryAfterMs = record.retryAfterMs;
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_AFTER_BACKOFF_CEILING_MS);
  }
  return (
    retryAfterMsFromUnknown(record.error, depth + 1) ??
    retryAfterMsFromUnknown(record.reason, depth + 1) ??
    retryAfterMsFromUnknown(record.cause, depth + 1)
  );
}

export function policyBreakerState(policy: IPolicy): 'open' | 'half-open' | 'closed' {
  const wrapped = (policy as IPolicy & { readonly wrapped?: readonly IPolicy[] }).wrapped;
  if (!Array.isArray(wrapped)) return 'closed';
  for (const inner of wrapped) {
    const state = (inner as { readonly state?: CircuitState }).state;
    if (state === CircuitState.Open) return 'open';
    if (state === CircuitState.HalfOpen) return 'half-open';
  }
  return 'closed';
}

function isTimeoutErrorLike(err: unknown): boolean {
  return (
    (err instanceof Error || err instanceof DOMException) &&
    err.name === 'TimeoutError'
  );
}

function abortablePolicy(policy: IPolicy): IPolicy {
  return {
    _altReturn: undefined as never,
    onFailure: policy.onFailure,
    onSuccess: policy.onSuccess,
    wrapped: (policy as IPolicy & { readonly wrapped?: readonly IPolicy[] }).wrapped,
    execute<T>(fn: (context: { signal: AbortSignal }) => PromiseLike<T> | T, signal?: AbortSignal) {
      if (!signal) return policy.execute(fn);
      if (signal.aborted) {
        return Promise.reject(abortReason(signal));
      }
      const policyPromise = policy.execute(fn, signal);
      let removeAbortListener: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = () => {
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => {
          signal.removeEventListener('abort', onAbort);
        };
      });
      return Promise.race([policyPromise, abortPromise]).finally(() => {
        removeAbortListener?.();
        policyPromise.catch(() => {
          // Consume policy work that may still finish after an outer abort wins the race.
        });
      });
    },
  } as IPolicy;
}
