import { GptModerationCategoriesSchema, type GptModerationNotice } from '@atelier/shared';
import type { TileRow } from './types';

/** Shared by history, live terminal events and reconnect replay. */
export function tileModeration(row: Pick<TileRow, 'moderation_reason' | 'moderation_categories'>): GptModerationNotice | undefined {
  if (!row.moderation_reason) return undefined;
  const notice: GptModerationNotice = { reason: row.moderation_reason, target: 'image' };
  if (!row.moderation_categories || notice.reason === 'unavailable') return notice;
  try {
    const parsed = GptModerationCategoriesSchema.safeParse(JSON.parse(row.moderation_categories) as unknown);
    if (parsed.success) return { ...notice, categories: parsed.data };
  } catch { /* Keep the historical category when detailed metadata is unreadable. */ }
  return notice;
}
