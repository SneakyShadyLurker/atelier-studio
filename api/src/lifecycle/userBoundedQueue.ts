import { createBoundedQueue, type BoundedQueue, type BoundedQueueOptions } from './boundedQueue';

interface UserBoundedQueueOptions extends BoundedQueueOptions {
  readonly maxInFlightPerUser: number;
  readonly maxPendingPerUser: number;
}

// Independent resource pools share only their global/per-user admission
// mechanics. Idle user queues disappear, and canceled waiters own no work.
export function createUserBoundedQueue(options: UserBoundedQueueOptions) {
  const global = createBoundedQueue(options);
  const users = new Map<string, BoundedQueue>();
  return {
    async run<T>(userId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      let user = users.get(userId);
      if (!user) {
        user = createBoundedQueue({
          maxInFlight: options.maxInFlightPerUser,
          maxPending: options.maxPendingPerUser,
          queueFullError: options.queueFullError,
        });
        users.set(userId, user);
      }
      try {
        // A user's pending global acquisitions already consume its local
        // slots, so it cannot fill the global queue beyond its active share.
        return await user.run(() => global.run(fn, signal), signal);
      } finally {
        if (user.inFlightCount === 0 && user.pendingCount === 0 && users.get(userId) === user) users.delete(userId);
      }
    },
    resetForTests(): void {
      global.resetForTests();
      for (const user of users.values()) user.resetForTests();
      users.clear();
    },
  };
}
