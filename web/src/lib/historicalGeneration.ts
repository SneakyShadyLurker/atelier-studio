import { MAX_TILE_COUNT } from '@atelier/shared';
import type { Batch, GenerateRequest, Model, Tile } from '@atelier/shared';
import { nextSeed } from './seed';

// Build one history action's GenerateRequest. Re-roll draws its seed once here;
// Retry retains its explicit seed, and resends keep this action's inputs. The rerun is
// standalone: sequence linkage (extendsTileId) is never carried, so an I2V
// segment replays as a plain animation of its persisted source still.
export type HistoricalReplay =
  | { readonly kind: 'reroll' }
  | { readonly kind: 'retry'; readonly tile: Tile; readonly seed: number };

export function buildHistoricalRequest(batch: Batch, replay: HistoricalReplay): GenerateRequest {
  const batchRefImageIds = batch.tiles.find((t) => t.refImageIds && t.refImageIds.length > 0)?.refImageIds;
  const refImageIds = replay.kind === 'retry' && replay.tile.refImageIds && replay.tile.refImageIds.length > 0
    ? replay.tile.refImageIds
    : batchRefImageIds;
  return {
    prompt: batch.prompt,
    modelId: batch.modelId,
    ratio: batch.ratio,
    ...(replay.kind === 'retry'
      ? { count: 1, seed: replay.seed }
      : { count: Math.min(MAX_TILE_COUNT, Math.max(1, batch.tiles.length)), seed: nextSeed() }),
    ...(refImageIds ? { refImageIds } : {}),
    ...(batch.i2vSourceUploadId ? { i2vSourceUploadId: batch.i2vSourceUploadId } : {}),
    ...(batch.durationFrames !== undefined ? { durationFrames: batch.durationFrames } : {}),
    ...(batch.provenance && batch.provenance.templateId !== null ? {
      provenance: {
        templateId: batch.provenance.templateId,
        rollSeed: batch.provenance.rollSeed,
        pins: batch.provenance.pins,
      },
    } : {}),
  };
}

export const RETIRED_MODEL_TOAST = 'This model is no longer available. Copy the prompt and choose an available model.';

// A model is retired only when a successfully fetched inventory lacks it.
// Pending or failed inventory proves nothing, so the server stays the judge;
// offline-but-registered models are still listed and keep server handling.
export function isRetiredHistoricalModel(
  modelId: string,
  modelById: ReadonlyMap<string, Model>,
  inventoryLoaded: boolean,
): boolean {
  return inventoryLoaded && !modelById.has(modelId);
}
