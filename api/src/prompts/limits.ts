export const PROMPT_ARRAY_TRANSPORT_MAX = 2_000;

// Hard upper bound aligned with the env-overridable MAX_TEMPLATE_BODY_BYTES
// budget. 4× the 65 KiB default leaves headroom for raised limits without
// letting a single POST allocate megabytes of JSON pre-Zod-narrow. The route
// still runs a precise per-request Buffer.byteLength check against the live
// config value for the env-raised path. `loadConfig` caps
// `MAX_TEMPLATE_BODY_BYTES` at this value so an operator-raised runtime limit
// can never sit above this transport ceiling.
export const TEMPLATE_BODY_HARD_MAX = 262_144;
