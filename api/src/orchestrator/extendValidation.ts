import type { Database } from 'bun:sqlite';
import type { Ratio } from '@atelier/shared';
import { getSequenceTail } from '../db/sequences';

export interface ExtensionSourceRow {
  readonly batch_id: string;
  readonly ratio: Ratio;
  readonly sequence_id: string | null;
}

export type ExtensionCheck =
  | { readonly status: 'ok'; readonly source: ExtensionSourceRow }
  | { readonly status: 'not-found' }
  | { readonly status: 'not-tail' }
  | { readonly status: 'sequence-full' }
  | { readonly status: 'ratio-mismatch' }
  | { readonly status: 'provenance-mismatch' };

export function validateExtension(
  db: Database,
  userId: string,
  tileId: string,
  uploadId: string,
  ratio: Ratio,
  maxSegments: number,
): ExtensionCheck {
  const source = db.query<ExtensionSourceRow, [string, string]>(
    `SELECT b.id AS batch_id, b.ratio, b.sequence_id
       FROM tiles t
       JOIN batches b ON b.id = t.batch_id AND b.user_id = t.user_id
      WHERE t.id = ?
        AND t.user_id = ?
        AND t.status = 'done'
        AND t.ext = 'mp4'
        AND t.mime = 'video/mp4'
        AND b.status = 'done'`,
  ).get(tileId, userId);
  if (!source) return { status: 'not-found' };
  const upload = db.query<{ source_tile_id: string | null }, [string, string]>(
    'SELECT source_tile_id FROM uploads WHERE id = ? AND user_id = ?',
  ).get(uploadId, userId);
  if (upload?.source_tile_id !== tileId) return { status: 'provenance-mismatch' };

  if (source.sequence_id === null) {
    return source.ratio === ratio
      ? { status: 'ok', source }
      : { status: 'ratio-mismatch' };
  }
  const tail = getSequenceTail(db, userId, source.sequence_id);
  if (tail?.batch.id !== source.batch_id) return { status: 'not-tail' };
  const count = db.query<{ count: number }, [string, string]>(
    'SELECT COUNT(*) AS count FROM batches WHERE sequence_id = ? AND user_id = ?',
  ).get(source.sequence_id, userId)?.count ?? 0;
  if (count >= maxSegments) return { status: 'sequence-full' };
  const sequenceRatio = db.query<{ ratio: Ratio }, [string, string]>(
    `SELECT ratio FROM batches
      WHERE sequence_id = ? AND user_id = ?
      ORDER BY sequence_index ASC LIMIT 1`,
  ).get(source.sequence_id, userId)?.ratio;
  if (sequenceRatio === undefined || sequenceRatio !== ratio) return { status: 'ratio-mismatch' };
  return { status: 'ok', source };
}
