/** The queue position as the feed shows it, on the batch header and its queued tiles. */
export function queueLabel(queueLengthAhead: number | undefined): string {
  if (queueLengthAhead === undefined) return 'Queued';
  return queueLengthAhead > 0
    ? `Queued · #${String(queueLengthAhead + 1)}`
    : 'Queued · head';
}
