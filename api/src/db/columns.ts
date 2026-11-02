import type { BatchRow, TileRow } from './types';

// Explicit column lists so `SELECT *` doesn't widen the wire shape under
// schema migrations. The `satisfies Record<keyof T, true>` constraints are
// the load-bearing guardrail: adding a column to BatchRow / TileRow without
// adding it here is a compile error (a `query<T>` site is a cast, not a
// runtime narrowing, so these lists own column coverage for every reader).
const BATCH_COLUMN_KEYS = {
  id: true, user_id: true, prompt: true, ratio: true, model_id: true,
  model_label: true, created_at: true, archived_at: true,
  collection_id: true, pinned: true, status: true, pool: true,
  template_id: true, roll_seed: true, roll_pins: true,
  i2v_source_upload_id: true, motion_prompt: true,
  duration_frames: true,
  sequence_id: true, sequence_index: true, context_frames: true,
  started_at: true, idempotency_key: true,
} as const satisfies Record<keyof BatchRow, true>;
const TILE_COLUMN_KEYS = {
  id: true, batch_id: true, user_id: true, tile_index: true, seed: true,
  status: true, ext: true, mime: true, error: true, completed_at: true,
  archived_at: true, moderation_reason: true, moderation_categories: true,
} as const satisfies Record<keyof TileRow, true>;

export const BATCH_COLUMNS = Object.keys(BATCH_COLUMN_KEYS).join(', ');
export const TILE_COLUMNS = Object.keys(TILE_COLUMN_KEYS).join(', ');
