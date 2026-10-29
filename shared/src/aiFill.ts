import { findTokens } from './templateTokens';

// Code-owned separator the fill model must emit between fills (never inside one).
// Lowercase-free, bracket-free sentinel so it can't collide with prompt prose or
// be rendered as on-image text. Mirrors BRAINSTORM_FIELD_SEPARATOR.
export const AI_FILL_FIELD_SEPARATOR = '<<<§ATELIER_AIFILL_FIELD§>>>';
export const AI_FILL_RECORD_SEPARATOR = '<<<§ATELIER_AIFILL_RECORD§>>>';

/** Reconstructs an unresolved prompt from its static segments. */
export function buildAiFillSkeleton(staticSegments: readonly string[]): string {
  let out = staticSegments[0] ?? '';
  for (let i = 1; i < staticSegments.length; i += 1) {
    out += `[[${i}]]${staticSegments[i] ?? ''}`;
  }
  return out;
}

// One upstream request stays small enough for reliable two-level plain-text
// parsing while amortizing the common Generate/sweep burst.
export const AI_FILL_BATCH_MAX = 4;

// A retired directive that stored templates may still carry. It is stripped
// before resolution so it never reaches an image prompt.
const CARD_NOTES_TOKEN = '{{card-notes}}';

// Upper bound on ai-fill slots per prompt — one LLM call fills all of them, so a
// runaway count would bloat the request and the bill. Enforced in the schema.
export const AI_FILL_MAX_SLOTS = 8;

// Max characters per ai-fill INSTRUCTION. An instruction is a throwaway compile
// directive the LLM consumes to synthesize a fill — it never reaches the image
// model (which only ever sees the final spliced prompt, itself capped at
// MAX_PROMPT_CHARS). So it is NOT bounded by the image-prompt cap; it is bounded
// only by what the resolving text model can digest. Kimi K3's one-million-token
// context has ample room for 50k chars (~12.5k tokens, a multi-page brief,
// ~8× MAX_PROMPT_CHARS).
// Enforced in aiFill.schema.ts.
export const AI_FILL_MAX_INSTRUCTION_CHARS = 50_000;

// Max characters for the WHOLE ai-fill input — the static skeleton plus every
// instruction combined. ~200k chars ≈ 50k tokens; with the 8k-token output
// reserve and the ~2k-token system metaprompt that is ~60k tokens - well within
// Kimi K3's context window and far below the 53 MB Bun.serve body cap. Bounds
// total latency/cost and
// single-request abuse without constraining any realistic prompt. (The static
// portion is separately held < MAX_PROMPT_CHARS because it is verbatim in the
// final image prompt.) Enforced in aiFill.schema.ts.
export const AI_FILL_MAX_INPUT_CHARS = 200_000;

// NUL-delimited mask sentinel. NUL never appears in a user prompt, so masking is
// collision-proof; maskAiFillTokens asserts the input is NUL-free regardless.
const SENTINEL_NUL = '\u0000';
const aiFillSentinel = (i: number): string => `${SENTINEL_NUL}AIFILL${i}${SENTINEL_NUL}`;

// `{{ai-fill: ...}}` or `{{ai-fill:: ...}}` — instruction is everything after the
// colon(s). Applied to a token's INNER text (after stripping the {{ }}).
const AI_FILL_INNER_RE = /^ai-fill::?\s*([\s\S]*)$/;

export interface AiFillSlot {
  readonly instruction: string;
}

export interface ParsedAiFill {
  readonly slots: readonly AiFillSlot[];
  // staticSegments.length === slots.length + 1; interleaves with fills on assembly.
  readonly staticSegments: readonly string[];
  // Read-only context for the LLM: static text with each slot as a [[N]] marker.
  readonly skeleton: string;
}

export function hasAiFillTokens(prompt: string): boolean {
  return prompt.includes('{{ai-fill:');
}

/** Characters of static text that land verbatim in the filled prompt. */
export function staticSegmentsLength(staticSegments: readonly string[]): number {
  return staticSegments.reduce((total, segment) => total + segment.length, 0);
}

// Length a prompt counts against MAX_PROMPT_CHARS before filling: an ai-fill
// instruction is a throwaway compile directive the text model consumes, so only
// the static skeleton counts. The FINAL filled text is re-checked post-fill.
export function aiFillMeasuredLength(prompt: string): number {
  return hasAiFillTokens(prompt) ? staticSegmentsLength(parseAiFillTokens(prompt).staticSegments) : prompt.length;
}

// Strip only the exact bare token. Everything around it remains byte-identical;
// malformed or parameterized lookalikes stay literal.
export function stripCardNotesToken(prompt: string): string {
  if (!prompt.includes(CARD_NOTES_TOKEN)) return prompt;
  let text = '';
  let cursor = 0;
  for (const span of findTokens(prompt)) {
    if (span.text !== CARD_NOTES_TOKEN) continue;
    text += prompt.slice(cursor, span.start);
    cursor = span.end;
  }
  return text + prompt.slice(cursor);
}

// Depth-aware parse (findTokens treats {{random::{{var::x}}}} as one outer token),
// so an ai-fill instruction that itself contains {{...}} is captured whole. Any
// {{...}} token that is NOT an ai-fill token is left inside the static segments.
export function parseAiFillTokens(prompt: string): ParsedAiFill {
  const slots: AiFillSlot[] = [];
  const staticSegments: string[] = [];
  let cursor = 0;
  let skeleton = '';
  for (const span of findTokens(prompt)) {
    const inner = span.text.slice(2, -2);
    const m = AI_FILL_INNER_RE.exec(inner);
    if (!m) continue; // not ai-fill → stays part of the next static slice
    const before = prompt.slice(cursor, span.start);
    staticSegments.push(before);
    skeleton += `${before}[[${slots.length + 1}]]`;
    slots.push({ instruction: (m[1] ?? '').trim() });
    cursor = span.end;
  }
  const tail = prompt.slice(cursor);
  staticSegments.push(tail);
  skeleton += tail;
  return { slots, staticSegments, skeleton };
}

export function assembleAiFillPrompt(
  staticSegments: readonly string[],
  fills: readonly string[],
): string {
  if (fills.length !== staticSegments.length - 1) {
    throw new Error(`ai-fill count mismatch: ${fills.length} fills for ${staticSegments.length - 1} slots`);
  }
  let out = staticSegments[0] ?? '';
  for (let i = 0; i < fills.length; i++) {
    out += `${fills[i] ?? ''}${staticSegments[i + 1] ?? ''}`;
  }
  return out;
}

export interface MaskedAiFill {
  readonly masked: string;
  readonly slotCount: number;
}

// Replace each ai-fill token with a NUL sentinel so the synchronous var/random
// resolver runs over the surrounding text without seeing — or mangling — the
// instruction text, and so the resolved static segments can be recovered by
// splitting on the sentinels afterward.
export function maskAiFillTokens(prompt: string): MaskedAiFill {
  if (prompt.includes(SENTINEL_NUL)) {
    throw new Error('cannot mask ai-fill: prompt contains a reserved NUL byte');
  }
  const { slots, staticSegments } = parseAiFillTokens(prompt);
  let masked = staticSegments[0] ?? '';
  for (let i = 0; i < slots.length; i++) {
    masked += `${aiFillSentinel(i)}${staticSegments[i + 1] ?? ''}`;
  }
  return { masked, slotCount: slots.length };
}

export function splitOnAiFillSentinels(masked: string, slotCount: number): string[] {
  const segments: string[] = [];
  let rest = masked;
  for (let i = 0; i < slotCount; i++) {
    const idx = rest.indexOf(aiFillSentinel(i));
    if (idx === -1) throw new Error(`ai-fill sentinel ${i} lost during resolution`);
    segments.push(rest.slice(0, idx));
    rest = rest.slice(idx + aiFillSentinel(i).length);
  }
  segments.push(rest);
  // Collision guard: the only NUL bytes in `masked` are the slotCount sentinels,
  // all consumed above. A residual NUL means resolution INSERTED a sentinel-shaped
  // value (e.g. a {{var}} option value forged to look like a sentinel) and the
  // split may have cut at the wrong place — reject rather than mis-splice. The
  // raw-prompt NUL check in maskAiFillTokens only covers pre-resolution input.
  if (segments.some((s) => s.includes(SENTINEL_NUL))) {
    throw new Error('ai-fill sentinel collision in resolved static text');
  }
  return segments;
}
