import type {
  BatchStatus,
  GptModerationReason,
  MediaExt,
  MediaMime,
  Pool,
  Ratio,
  TileErrorCategory,
  TileExt,
  TileMime,
  TileStatus,
} from '@atelier/shared';

export interface BatchRow {
  id: string;
  user_id: string;
  prompt: string;
  ratio: Ratio;
  model_id: string;
  model_label: string;
  created_at: number;
  archived_at: number | null;
  collection_id: string | null;
  pinned: 0 | 1;
  status: BatchStatus;
  pool: Pool;
  template_id: string | null;
  roll_seed: number | null;
  roll_pins: string | null;
  i2v_source_upload_id: string | null;
  motion_prompt: string | null;
  /** Clip length in frames; null on image batches. Constrained to the H3 grid. */
  duration_frames: number | null;
  sequence_id: string | null;
  sequence_index: number | null;
  /**
   * Frames of the previous segment that H3 was given as an AddGuide context
   * head, and that the stitcher therefore discards from the front of this
   * segment. 0 on every image batch, every first segment, and every
   * continuation that fell back to the still-frame graph — so it records how
   * the segment WAS rendered, not what was requested, and is written at
   * dispatch rather than at submit.
   */
  context_frames: number;
  /** When the batch left the queue and started rendering; null while queued. */
  started_at: number | null;
  /**
   * Client-supplied identity of one logical roll (POST /api/generate
   * `idempotencyKey`), unique per user when set; null for keyless submissions.
   */
  idempotency_key: string | null;
}

export interface CollectionRow {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: number;
}

export interface PromptTemplateRow {
  id: string;
  user_id: string;
  name: string;
  body: string;
  notes: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface VariableListRow {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface VariableOptionRow {
  id: string;
  user_id: string;
  list_id: string;
  value: string;
  sort_order: number;
  weight: number;
  created_at: number;
}

export interface TagDimensionRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: number;
}

export interface DimensionTagRow {
  id: string;
  user_id: string;
  dimension_id: string;
  label: string;
  sort_order: number;
  parent_id: string | null;
}

export interface TileRow {
  id: string;
  batch_id: string;
  user_id: string;
  tile_index: number;
  seed: number;
  status: TileStatus;
  // Polymorphic: image tiles store TileExt/TileMime; I2V (video) tiles store
  // 'mp4'/'video/mp4'. MediaExt/MediaMime is the superset both write through —
  // keep this widened so an exhaustive switch over `ext` sees the video case.
  ext: MediaExt | null;
  mime: MediaMime | null;
  error: TileErrorCategory | null;
  moderation_reason?: GptModerationReason | null;
  moderation_categories?: string | null;
  completed_at: number | null;
  archived_at: number | null;
}

export interface UploadRow {
  id: string;
  user_id: string;
  ext: TileExt;
  mime: TileMime;
  size_bytes: number;
  width: number;
  height: number;
  sha256: string;
  created_at: number;
  source_tile_id: string | null;
}
