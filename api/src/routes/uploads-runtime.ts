// Process-wide cap on concurrent multipart upload parsing. Bun.serve's
// maxRequestBodySize bounds each request to ~53 MB (MAX_UPLOAD_INPUT_BYTES
// + 3 MB multipart headroom), but absent a concurrency cap a burst of 50
// simultaneous uploads dumps ≈ 2.65 GB transient (multipart buffer + Uint8Array
// copy + normalize pipeline). A slow-path upload may decode + re-encode via
// Sharp (and a heif-convert subprocess for HEIC) inside the slot, so peak
// transient RAM per slot includes a decode buffer bounded by the 100 MP input
// ceiling — not just the ~53 MB envelope.
//
// Per-user layer ensures fairness across users so one tenant can't 503
// everyone else. It QUEUES (not rejects) within a per-user pending cap that
// comfortably accommodates a single Composer batch (Gemini accepts up to 10
// reference images; the Composer dispatches them all concurrently), so a
// normal multi-ref upload always completes — only a malicious burst past
// MAX_PENDING_UPLOADS_PER_USER trips the 503. Both layers are BoundedQueues;
// the global one owns the process-wide back-pressure.

import { createBoundedQueue, type BoundedQueue } from '../lifecycle/boundedQueue';

export const MAX_CONCURRENT_UPLOADS = 4;
export const MAX_PENDING_UPLOADS = 20;
export const MAX_CONCURRENT_UPLOADS_PER_USER = 2;
// Matches the global pending depth; lets a single user batch up to
// MAX_CONCURRENT_UPLOADS_PER_USER + MAX_PENDING_UPLOADS_PER_USER = 22 uploads
// before 503ing, which absorbs every shipped model's `maxRefImages` (10) with
// 2× headroom while still bounding memory if a user hammers /uploads.
export const MAX_PENDING_UPLOADS_PER_USER = 20;

export class UploadQueueFullError extends Error {
  constructor() {
    super('upload queue full');
    this.name = 'UploadQueueFullError';
  }
}

const queue = createBoundedQueue({
  maxInFlight: MAX_CONCURRENT_UPLOADS,
  maxPending: MAX_PENDING_UPLOADS,
  queueFullError: () => new UploadQueueFullError(),
});

// One bounded queue per user with live work; dropped once idle so the map
// only holds users with uploads in flight or queued.
const perUserQueues = new Map<string, BoundedQueue>();

function perUserQueue(userId: string): BoundedQueue {
  let userQueue = perUserQueues.get(userId);
  if (!userQueue) {
    userQueue = createBoundedQueue({
      maxInFlight: MAX_CONCURRENT_UPLOADS_PER_USER,
      maxPending: MAX_PENDING_UPLOADS_PER_USER,
      queueFullError: () => new UploadQueueFullError(),
    });
    perUserQueues.set(userId, userQueue);
  }
  return userQueue;
}

export async function withUploadSlot<T>(
  userId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const userQueue = perUserQueue(userId);
  try {
    // The per-user slot is held while waiting for a global one, so one user
    // can never occupy more than its share of the global queue.
    return await userQueue.run(() => queue.run(fn, signal), signal);
  } finally {
    if (userQueue.inFlightCount === 0 && userQueue.pendingCount === 0 && perUserQueues.get(userId) === userQueue) {
      perUserQueues.delete(userId);
    }
  }
}

export function resetUploadsRuntimeForTests(): void {
  queue.resetForTests();
  for (const userQueue of perUserQueues.values()) userQueue.resetForTests();
  perUserQueues.clear();
}
