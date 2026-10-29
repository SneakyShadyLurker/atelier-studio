// Module-level registry of in-flight generation AbortControllers,
// shared between useGenerate (writer) and useCancel / useDeleteTile /
// useDeleteBatch (readers). Batch-level only: there is no client-side
// per-tile controller because there's only one fetch per generation,
// so a single AbortController covers all tiles in a batch. Per-tile
// cancel is server-mediated via DELETE /history/:batchId/:tileId
// hitting the server's per-tile registry.

export interface BatchControl {
  readonly controller: AbortController;
}

const inFlight = new Map<string, BatchControl>();

export function registerBatch(batchId: string, controller: AbortController): void {
  inFlight.set(batchId, { controller });
}

export function getBatch(batchId: string): BatchControl | undefined {
  return inFlight.get(batchId);
}

export function unregisterBatch(batchId: string): void {
  inFlight.delete(batchId);
}

export function resetInFlightForTests(): void {
  inFlight.clear();
}
