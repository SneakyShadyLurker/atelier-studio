-- Dispatch time: when a batch left the queue and started rendering. The
-- feed's elapsed clock and stuck-poll cap count from here, not from
-- created_at, so queue wait is never reported as render time. Rows that
-- already left the queue are backfilled with created_at, the best estimate.
ALTER TABLE batches ADD COLUMN started_at INTEGER;
UPDATE batches SET started_at = created_at WHERE status <> 'queued';
