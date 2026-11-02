import type { Database } from 'bun:sqlite';
import type { TileRow } from './types';

// Single owner of the user-scoped done-tile predicate that gates every read of
// a finished artifact (/img/:tileId(/thumb), the Ephemera character card).
// The predicate filters non-null ext/mime, so the shape is the non-null
// projection of TileRow's media columns (the SSOT: image OR video ext/mime).
const DONE_TILE_PREDICATE =
  "t.id = ? AND t.user_id = ? AND t.status = 'done' AND t.ext IS NOT NULL AND t.mime IS NOT NULL";

export interface DoneTileMedia {
  ext: NonNullable<TileRow['ext']>;
  mime: NonNullable<TileRow['mime']>;
}

export interface DoneTileWithPrompt extends DoneTileMedia {
  /** The batch's rendered prompt (`batches.prompt`). */
  prompt: string;
}

export function selectDoneTile(db: Database, tileId: string, userId: string): DoneTileMedia | null {
  return db
    .query<DoneTileMedia, [string, string]>(`SELECT t.ext, t.mime FROM tiles t WHERE ${DONE_TILE_PREDICATE}`)
    .get(tileId, userId);
}

/** The done tile plus its batch prompt, read in one user-scoped query. */
export function selectDoneTileWithPrompt(db: Database, tileId: string, userId: string): DoneTileWithPrompt | null {
  return db
    .query<DoneTileWithPrompt, [string, string]>(
      `SELECT t.ext, t.mime, b.prompt
         FROM tiles t
         JOIN batches b ON b.id = t.batch_id AND b.user_id = t.user_id
        WHERE ${DONE_TILE_PREDICATE}`,
    )
    .get(tileId, userId);
}
