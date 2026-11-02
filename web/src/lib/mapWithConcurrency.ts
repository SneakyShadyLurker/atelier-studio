// Bounded-concurrency map that preserves input order in the result array.
//
// Used to throttle the submit-time LLM reformatting pipeline (ai-fill) so a
// burst of queued rolls doesn't fire every fill at the text backend at once — a
// thundering herd that balloons per-call latency (~330ms → ~40s) and truncates
// the answer, silently dropping rolls. `Promise.all` runs everything at once;
// this caps in-flight work at `limit` while keeping the same ordered result.
//
// Rejects on the first task rejection, matching `Promise.all` semantics — but
// the submit-path callers never reject (they catch and return a result union),
// so in practice this always resolves.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const cap = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  };

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
