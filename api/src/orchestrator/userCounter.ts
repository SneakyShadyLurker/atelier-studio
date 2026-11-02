// Per-user in-flight counter map maintenance, shared by the tile-concurrency
// pools (createCounterPool) and the LLM admission pools. Both keep a
// Map<userId, count> and need identical increment + floored-decrement-with-
// delete-on-zero semantics; the floor turns a double-release into a static-cap
// regression rather than an unbounded negative leak, and the delete keeps the
// map from growing one dead entry per user seen.

export function incUser(map: Map<string, number>, userId: string, count: number): void {
  map.set(userId, (map.get(userId) ?? 0) + count);
}

export function decUserFloored(map: Map<string, number>, userId: string, count: number): void {
  const next = Math.max(0, (map.get(userId) ?? 0) - count);
  if (next === 0) map.delete(userId);
  else map.set(userId, next);
}
