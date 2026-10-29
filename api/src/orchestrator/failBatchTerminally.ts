import type { Database } from 'bun:sqlite';
import type { TileErrorCategory } from '@atelier/shared';
import type { Config } from '../config';
import { SQL_LOADING_GUARD } from '../db/tombstone';
import { terminalFrame, type TerminalFrame } from '../lifecycle/sse';
import { finalizeBatch } from './finalize';
import { settleSequenceAfterBatchTerminal, type SequenceLogger } from './sequenceLifecycle';

export interface FailBatchTerminallyOptions {
  // Emits terminal bus frames (per-tile `failed` then `done`). Omit for a
  // DB-only teardown that records the failure without broadcasting.
  readonly emitTerminal?: (frame: TerminalFrame) => void;
  // Closes the bus for this batch (idempotent). Omit to leave it open for a
  // later `cleanup()` to close (the in-pipeline catch arms do this).
  readonly close?: () => void;
  // When false, suppress the `done` frame if no loading tiles were flipped —
  // the dequeue-fail path must not re-emit `done` for a batch another writer
  // already terminal'd. Defaults to true (the in-pipeline paths always emit).
  readonly emitDoneOnEmpty?: boolean;
}

// Single owner of the batch-teardown sequence: fail still-loading tiles
// (ordered per-tile frames) -> finalize the batch row -> broadcast the
// terminal `done` -> optionally close the bus -> settle the sequence/story
// terminal hook as failed. `failLoadingTiles` emits the per-tile frames
// before this emits `done`, preserving the dequeue path's tile-then-done
// ordering.
export function failBatchTerminally(
  db: Database,
  config: Config,
  logger: SequenceLogger,
  batchId: string,
  category: TileErrorCategory,
  opts: FailBatchTerminallyOptions = {},
): void {
  const { emitTerminal, close, emitDoneOnEmpty = true } = opts;
  const flipped = failLoadingTiles(db, batchId, category, emitTerminal);
  finalizeBatch(db, batchId);
  if (emitTerminal && (emitDoneOnEmpty || flipped > 0)) {
    emitTerminal(terminalFrame('done', { batchId }));
  }
  close?.();
  settleSequenceAfterBatchTerminal(db, config, logger, batchId, false);
}

// Flips every still-loading tile of the batch to `failed` and, when asked,
// emits one `failed` frame per flipped tile in tile order. RETURNING yields
// exactly the rows this call flipped (a concurrently deleted tile is simply
// absent). Returns the flipped count.
function failLoadingTiles(
  db: Database,
  batchId: string,
  error: TileErrorCategory,
  emitTerminal?: (frame: TerminalFrame) => void,
): number {
  const completedAt = Date.now();
  const flipped = db
    .query<{ id: string; tile_index: number }, [string, TileErrorCategory, number]>(
      `UPDATE tiles SET status = 'failed', error = ?2, completed_at = ?3
        WHERE batch_id = ?1 AND ${SQL_LOADING_GUARD}
        RETURNING id, tile_index`,
    )
    .all(batchId, error, completedAt);
  if (emitTerminal) {
    // RETURNING order is unspecified; the wire contract is tile order.
    for (const tile of flipped.toSorted((a, b) => a.tile_index - b.tile_index)) {
      emitTerminal(terminalFrame('tile', {
        tileId: tile.id,
        tileIndex: tile.tile_index,
        status: 'failed',
        error,
        completedAt,
      }));
    }
  }
  return flipped.length;
}
