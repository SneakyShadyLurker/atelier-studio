// Maximum prompt length the api accepts. Wire-contract bound shared by the
// generate + enhance route schemas and the composer character meter.
export const MAX_PROMPT_CHARS = 6000;

// Prompt-library request bounds, enforced by the api route schemas and mirrored
// by the web inputs so the UI never lets users type text that 400s on save.
// Every list and template name field.
export const PROMPT_LIBRARY_NAME_MAX_CHARS = 64;
// Free-text description seeding an AI list draft.
export const LIST_DESCRIPTION_MAX_CHARS = 2_000;
// Free-text description seeding an AI template draft.
export const TEMPLATE_DESCRIPTION_MAX_CHARS = 500;
