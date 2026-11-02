export const ERROR_PATTERN_MODERATION = /\b(moderation|moderation_blocked|safety|content[-_\s]?policy)\b/i;
export const ERROR_PATTERN_MODERATION_STRICT = /\b(content[-_\s]?policy|moderation_blocked)\b/i;
export const ERROR_PATTERN_DID_NOT_RETURN_IMAGE = /\bdid not return image\b/i;
export const ERROR_PATTERN_STREAM_DISCONNECTED_TEXT = 'stream disconnected';
export const ERROR_PATTERN_STREAM_DISCONNECTED_BEFORE_COMPLETION = /\bstream disconnected before completion\b/i;
export const ERROR_PATTERN_TIMEOUT = /\b(timeout|timed out|deadline|gateway timeout)\b/i;
export const ERROR_PATTERN_DEADLINE_EXCEEDED = /\b(timed out|timeout|deadline exceeded)\b/i;
