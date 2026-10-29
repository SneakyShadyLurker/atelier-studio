import type { GenerateRequest } from '@atelier/shared';

const drainOwnedRequests = new WeakSet<GenerateRequest>();

export function markDrainOwned(req: GenerateRequest): void {
  drainOwnedRequests.add(req);
}

export function isDrainOwned(req: GenerateRequest): boolean {
  return drainOwnedRequests.has(req);
}
