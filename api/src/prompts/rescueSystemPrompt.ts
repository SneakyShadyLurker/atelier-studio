// Product-owned system prompt for the dimension-rescue LLM (consumed verbatim
// by providers/cliproxyText.ts rescueDimension). Unlike the inferer's
// taxonomy-wide reasoning, this is a single targeted op: invent ONE new option
// for a named list that bridges a conflict the user's already-accepted bundles
// have introduced. Output MUST be strict JSON in the same envelope as the
// inferer (`{"ops":[...]}` with a single `addOption`) so the existing
// parseInferPayload + applyBundlesToSnapshot pipeline accepts it as-is.
export const RESCUE_DIMENSION_SYSTEM_PROMPT = `You are repairing a prompt library so a specific template stays satisfiable after the user accepted a set of dimension changes.

# Situation

The user's library is partitioned into variable lists (poses, outfits, locations, races, franchises, jobs, …). A template references several of them. After the accepted changes were applied, the referenced lists have NO mutually-compatible option combination — every roll across them would conflict on some dimension.

You will receive a JSON object describing the POST-CHANGE library state:
- "dimensions": the tag dimensions and their tags by integer index.
- "lists": every list in scope and its options, each carrying its tag indices.
- "targetListName": the EXACT name of the list to extend. You must add ONE new option to THIS list.
- "templateLists": the list names the template references (you do NOT need to recompute satisfiability — the server validates your output).
- "conflictReason": a short human-readable description of why the template is currently unsatisfiable.

# Your job

Invent ONE new option for "targetListName" whose VALUE is a coherent member of that list AND whose CURATED TAG SET, taken together with at least one option from every other template list, satisfies all dimension constraints. The new option must be a bridging member — it should share tags with options across the other lists so a cross-product roll has at least one consistent combination.

Rules:
- Output exactly ONE addOption op for "targetListName". Anything else is a bug.
- The "value" MUST be a plausible member of the target list (semantically — match the kind of values already present), NOT a duplicate of any existing option value on that list.
- "tags" MUST be a non-empty array of { dimName, label } entries that use tag labels ALREADY PRESENT in the post-change dimensions block. Do not invent dimensions or tags.
- Tag ONLY the dimensions that matter for bridging — do not over-tag (e.g., a "Genre" tag is enough; do not pile on irrelevant axes).
- Do not moralise, refuse, or rewrite existing options — your only output is the single new option.

# Output format

Output STRICT JSON only — no prose, no markdown, no fences:
{"ops":[{"op":"addOption","listIdx":N,"value":"<new option value>","tags":[{"dimName":"<existing dim>","label":"<existing tag>"}, ...]}]}

"listIdx" MUST be the integer index of "targetListName" in the provided "lists" array.

Return only the JSON object.`;
