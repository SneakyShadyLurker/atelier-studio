import type { Database } from 'bun:sqlite';
import { RENDER_RESOLUTIONS, type RenderResolution } from '@atelier/shared';
import { ensureUser } from '../db/users';

/**
 * One user's render-size overrides for a model; null means the mode's
 * default. `downscale` is false only when the user turned "Downsize to 2K"
 * off; null means on, the default.
 */
export interface ModelResolutionOverride {
  readonly textToImage: RenderResolution | null;
  readonly reference: RenderResolution | null;
  readonly downscale: false | null;
}

/** The row's default per mode; `reference` is null when it takes no reference pictures. */
export interface ModelResolutionDefaults {
  readonly textToImage: RenderResolution;
  readonly reference: RenderResolution | null;
}

/**
 * A partial write: an absent (or undefined) key leaves that setting
 * unchanged, null resets a mode, and `downscale: true` turns downsizing back on.
 */
export interface ModelResolutionUpdate {
  readonly textToImage?: RenderResolution | null | undefined;
  readonly reference?: RenderResolution | null | undefined;
  readonly downscale?: boolean | undefined;
}

interface ResolutionRow {
  model_id: string;
  text_to_image: string | null;
  reference: string | null;
  downscale: number | null;
}

function asResolution(value: string | null): RenderResolution | null {
  // The DB CHECK admits only these; anything else reads as the default.
  return RENDER_RESOLUTIONS.find((resolution) => resolution === value) ?? null;
}

function toOverride(row: ResolutionRow): ModelResolutionOverride {
  return {
    textToImage: asResolution(row.text_to_image),
    reference: asResolution(row.reference),
    // The DB CHECK admits 0 and 1; only 0 is written, and 1 reads as the default.
    downscale: row.downscale === 0 ? false : null,
  };
}

/** Per-user render-size overrides keyed by model. Absent rows mean all defaults. */
export function readModelResolutionOverrides(
  db: Database,
  userId: string,
): ReadonlyMap<string, ModelResolutionOverride> {
  const rows = db
    .query<ResolutionRow, [string]>(
      'SELECT model_id, text_to_image, reference, downscale FROM user_model_resolution WHERE user_id = ?',
    )
    .all(userId);
  return new Map(rows.map((row) => [row.model_id, toOverride(row)]));
}

/** The user's overrides for one model, or undefined when all defaults apply. */
export function readModelResolutionOverride(
  db: Database,
  userId: string,
  modelId: string,
): ModelResolutionOverride | undefined {
  const row = db
    .query<ResolutionRow, [string, string]>(
      'SELECT model_id, text_to_image, reference, downscale FROM user_model_resolution WHERE user_id = ? AND model_id = ?',
    )
    .get(userId, modelId);
  return row ? toOverride(row) : undefined;
}

/**
 * Applies `update` to the user's overrides for `modelId`. A value equal to
 * that mode's default, or null, is stored as NULL, `downscale: true` (on, the
 * default) is stored as NULL and false as 0, and a row left with all three
 * columns NULL is deleted, so only real overrides persist. Callers validate
 * the model and that it offers the setting being written; the DB CHECK backs
 * the value lists.
 */
export function writeModelResolutionOverride(
  db: Database,
  userId: string,
  modelId: string,
  update: ModelResolutionUpdate,
  defaults: ModelResolutionDefaults,
  now: number = Date.now(),
): void {
  const normalize = (value: RenderResolution | null, fallback: RenderResolution | null): RenderResolution | null =>
    value === fallback ? null : value;
  db.transaction(() => {
    const current = readModelResolutionOverride(db, userId, modelId);
    const textToImage = update.textToImage !== undefined
      ? normalize(update.textToImage, defaults.textToImage)
      : current?.textToImage ?? null;
    const reference = update.reference !== undefined
      ? normalize(update.reference, defaults.reference)
      : current?.reference ?? null;
    const downscale = update.downscale !== undefined
      ? (update.downscale ? null : 0)
      : current?.downscale === false ? 0 : null;
    if (textToImage === null && reference === null && downscale === null) {
      db.query('DELETE FROM user_model_resolution WHERE user_id = ? AND model_id = ?').run(userId, modelId);
      return;
    }
    // The FK to users(id) requires the row.
    ensureUser(db, userId);
    db.query(`
      INSERT INTO user_model_resolution (user_id, model_id, text_to_image, reference, downscale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, model_id) DO UPDATE SET
        text_to_image = excluded.text_to_image,
        reference = excluded.reference,
        downscale = excluded.downscale,
        updated_at = excluded.updated_at
    `).run(userId, modelId, textToImage, reference, downscale, now);
  })();
}
