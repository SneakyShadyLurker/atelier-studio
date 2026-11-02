import type { Database } from 'bun:sqlite';
import {
  VIDEO_CONTEXT_FRAMES,
  renderedVideoFrames,
  type VideoDurationFrames,
} from '@atelier/shared';

interface RateRow {
  readonly created_at: number;
  readonly completed_at: number;
  readonly duration_frames: number;
  readonly context_frames: number;
}

export function estimateStoryEtaMs(
  db: Database,
  segments: readonly { durationFrames: VideoDurationFrames; isContinuation: boolean }[],
): number {
  const rows = db.query<RateRow, []>(
    `SELECT b.created_at, t.completed_at, b.duration_frames, b.context_frames
       FROM batches b
       JOIN tiles t ON t.batch_id = b.id AND t.user_id = b.user_id
      WHERE b.duration_frames IS NOT NULL
        AND t.status = 'done'
        AND t.completed_at IS NOT NULL
        AND (SELECT COUNT(*) FROM tiles one_tile WHERE one_tile.batch_id = b.id) = 1
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT 8`,
  ).all();
  const rates = rows
    .map((row) => (
      (row.completed_at - row.created_at) / 1000 / (row.context_frames + row.duration_frames)
    ))
    .filter((rate) => Number.isFinite(rate))
    .sort((a, b) => a - b);
  const middle = Math.floor(rates.length / 2);
  const median = rates.length === 0
    ? 2
    : rates.length % 2 === 1
      ? rates[middle] ?? 2
      : ((rates[middle - 1] ?? 2) + (rates[middle] ?? 2)) / 2;
  const secondsPerFrame = Math.min(10, Math.max(0.3, median));
  const total = segments.reduce((sum, segment) => (
    sum
      + secondsPerFrame * 1000 * renderedVideoFrames(
          segment.durationFrames,
          segment.isContinuation ? VIDEO_CONTEXT_FRAMES : 0,
        )
      + 45_000
  ), 0);
  return Math.round(total);
}
