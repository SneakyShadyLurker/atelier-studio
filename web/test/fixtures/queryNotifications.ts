/**
 * TanStack Query hands observer updates to React from deferred
 * `notifyManager` batches (a `setTimeout(0)` each), and one settled query or
 * mutation can chain more than one. test/setup.ts delivers every batch inside
 * act; awaiting a few chained macrotask ticks here lets the pending ones land
 * before a test asserts on them or tears down. Call only inside
 * `act(async () => { ... })`.
 */
export async function flushQueryNotifications(): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
