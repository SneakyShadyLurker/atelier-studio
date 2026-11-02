// JSON buffering has a separate fixed budget from media work: four bodies
// per size class globally, two per user, bounded waiters. Small control bodies
// retain capacity while large library bodies and credential probes use their
// own pools (48 MiB and 1 MiB respectively).
import { createUserBoundedQueue } from '../lifecycle/userBoundedQueue';

export const MAX_CONCURRENT_JSON_BODIES = 4;
export const MAX_PENDING_JSON_BODIES = 20;
export const MAX_CONCURRENT_JSON_BODIES_PER_USER = 2;
export const MAX_PENDING_JSON_BODIES_PER_USER = 20;

export class JsonBodyQueueFullError extends Error {
  constructor() {
    super('request body queue full');
    this.name = 'JsonBodyQueueFullError';
  }
}

const options = {
  maxInFlight: MAX_CONCURRENT_JSON_BODIES,
  maxPending: MAX_PENDING_JSON_BODIES,
  maxInFlightPerUser: MAX_CONCURRENT_JSON_BODIES_PER_USER,
  maxPendingPerUser: MAX_PENDING_JSON_BODIES_PER_USER,
  queueFullError: () => new JsonBodyQueueFullError(),
};
const queues = {
  small: createUserBoundedQueue(options), large: createUserBoundedQueue(options), credentials: createUserBoundedQueue(options),
};

export function withJsonBodySlot<T>(
  userId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  size: keyof typeof queues = 'small',
): Promise<T> {
  return queues[size].run(userId, fn, signal);
}

export function resetJsonBodyRuntimeForTests(): void {
  for (const queue of Object.values(queues)) queue.resetForTests();
}
