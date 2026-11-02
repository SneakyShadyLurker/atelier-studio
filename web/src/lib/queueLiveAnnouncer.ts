const LIVE_REGION_ATTR = 'data-atelier-queue-live';

function queueLiveRegion(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let region = document.querySelector<HTMLElement>(`[${LIVE_REGION_ATTR}]`);
  if (!region) {
    region = document.createElement('div');
    region.setAttribute(LIVE_REGION_ATTR, 'true');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    region.className = 'srOnly';
    document.body.append(region);
  }
  return region;
}

/**
 * Mount the empty region up front: assistive technology can miss a change to
 * a live region created in the same moment as its first message.
 */
export function prepareQueueLiveRegion(): void {
  queueLiveRegion();
}

export function announceGenerationStarted(modelName: string): void {
  const region = queueLiveRegion();
  if (region) region.textContent = `Generation started for ${modelName}`;
}

// Completion has ONE owner: this page-level region, de-duplicated per batch.
// Both the tab's own generation stream and a mounted batch row report a batch
// settling; whichever is first speaks. The stream covers a batch scrolled out
// of the virtualized feed or a switched-away view; the row covers batches this
// tab does not stream (after a reload, from another tab).
const MAX_ANNOUNCED_BATCHES = 200;
const announcedBatchIds = new Set<string>();
let settledInThisTick = false;

export function batchSettledMessage(done: number, failed: number): string {
  const total = done + failed;
  const noun = total === 1 ? 'image' : 'images';
  if (done === 0) return `${String(total)} ${noun} failed to generate`;
  if (failed > 0) return `${String(done)} of ${String(total)} ${noun} ready, ${String(failed)} failed`;
  return `${String(total)} ${noun} ready`;
}

export function announceBatchSettled(batchId: string, done: number, failed: number): void {
  if (done + failed === 0 || announcedBatchIds.has(batchId)) return;
  announcedBatchIds.add(batchId);
  if (announcedBatchIds.size > MAX_ANNOUNCED_BATCHES) {
    const oldest = announcedBatchIds.values().next().value;
    if (oldest !== undefined) announcedBatchIds.delete(oldest);
  }
  const region = queueLiveRegion();
  if (!region) return;
  // Batches settling in the same update (one history refetch can settle
  // several rows) join one message instead of overwriting each other: the
  // region is atomic, so the whole text is read once the update is done.
  const message = batchSettledMessage(done, failed);
  region.textContent = settledInThisTick ? `${region.textContent}. ${message}` : message;
  if (!settledInThisTick) {
    settledInThisTick = true;
    queueMicrotask(() => { settledInThisTick = false; });
  }
}

export function resetAnnouncedBatchesForTests(): void {
  announcedBatchIds.clear();
}
