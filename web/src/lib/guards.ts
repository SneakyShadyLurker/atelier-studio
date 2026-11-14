// Canonical runtime type guards for narrowing `unknown` at trust boundaries
// (persisted cache blobs, error envelopes, local state). API responses and
// stream frames validate through the shared schemas instead.

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}
