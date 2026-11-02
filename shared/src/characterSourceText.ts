/**
 * Maximum brainstorm brief text. Every consumer is an LLM prompt with a
 * six-figure token context, so this bounds request size, not model fit.
 */
export const CHARACTER_SOURCE_TEXT_MAX_CHARS = 30_000;
