import { diffWordsWithSpace } from 'diff';
import type { TemplateChangeWire, UnplacedReasonWire, UnplacedTemplateChangeWire } from './promptToolSchemas';
import { VAR_TOKEN_ANCHORED, findTokens } from './templateTokens';

/*
 * Where a template rework's find/replace operations go in the body that was
 * sent (the base). Offsets always point into the base, so every character
 * outside a change stays as it was. Shared by the api, which places the
 * model's answer, and the web app, which reviews and applies it. Pure and
 * deterministic: no clock, no randomness (spec template-rework-review R3).
 */

export type TemplateChange = TemplateChangeWire;
export type UnplacedReason = UnplacedReasonWire;
export type UnplacedTemplateChange = UnplacedTemplateChangeWire;

export interface TemplateOperation { why: string; find: string; replace: string }

export interface PlaceOptions {
  /** R3.4: the caller's token rules for one replacement. */
  sanitize: (replacement: string) => { text: string; warnings: readonly string[] };
  /** R3.8 limits: code points of growth, and UTF-8 bytes of the whole body. */
  maxGrowthChars: number;
  maxBodyBytes: number;
}

export interface TemplatePlacement {
  /** Sorted by start, id = index. */
  changes: TemplateChange[];
  /** Arrival order. */
  unplaced: UnplacedTemplateChange[];
  /** The why of a placed whole operation when non-empty, else null. */
  wholeWhy: string | null;
  /** Deduplicated, first-seen order, from placed changes only. */
  warnings: string[];
}

export interface WordRun { kind: 'same' | 'del' | 'ins'; text: string }

interface Range { start: number; end: number }
interface Edit extends Range { replace: string }

/** R3.9: diff budget for decomposing a whole operation. */
const WHOLE_DIFF_MAX_EDIT_LENGTH = 1500;
/** R3.9: hunks separated by at most this many unchanged words merge. */
const MERGE_GAP_WORDS = 2;
/** R3.9: a base over this many words must keep this share unchanged to be decomposed. */
const LONG_BASE_WORDS = 80;
const MIN_KEPT_SHARE = 0.4;

const WORD = /\S+/gu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

const codePoints = (text: string): number => Array.from(text).length;
const encoder = new TextEncoder();
const utf8Bytes = (text: string): number => encoder.encode(text).length;

// ---- scanner and token safety ----------------------------------------------

/**
 * The spec's scanner over `text`: `depth[p]` is the depth at boundary `p`
 * (before character `p`), `mid[p]` is 1 when a `{{` or `}}` pair straddles
 * boundary `p`. Both arrays have `text.length + 1` entries.
 */
interface Scan { depth: Int32Array; mid: Uint8Array }

function scan(text: string, startDepth = 0): Scan {
  const depth = new Int32Array(text.length + 1);
  const mid = new Uint8Array(text.length + 1);
  let d = startDepth;
  let i = 0;
  while (i < text.length) {
    depth[i] = d;
    const pair = text.slice(i, i + 2);
    if (pair === '{{' || pair === '}}') {
      depth[i + 1] = d;
      mid[i + 1] = 1;
      d += pair === '{{' ? 1 : -1;
      i += 2;
    } else {
      i += 1;
    }
  }
  depth[text.length] = d;
  return { depth, mid };
}

/** The lowest depth at a pair-free boundary in `[from, to]`. */
function minDepth(s: Scan, from: number, to: number): number {
  let low = Infinity;
  for (let p = from; p <= to; p += 1) {
    if (s.mid[p] === 0) low = Math.min(low, s.depth[p] ?? 0);
  }
  return low;
}

function tokenSafeIn(base: string, baseScan: Scan, { start, end, replace }: Edit): boolean {
  if (baseScan.mid[start] === 1 || baseScan.mid[end] === 1) return false;
  const startDepth = baseScan.depth[start] ?? 0;
  if (minDepth(baseScan, start, end) < startDepth) return false;
  // Scan the result only where it can differ: the character before the
  // replacement when the scanner reads it alone, the replacement, and the
  // character after it. Before that the result reads exactly as the base.
  const leftFree = start > 0 && baseScan.mid[start - 1] === 0;
  const left = leftFree ? base.charAt(start - 1) : '';
  const local = `${left}${replace}${base.charAt(end)}`;
  const localScan = scan(local, leftFree ? (baseScan.depth[start - 1] ?? 0) : startDepth);
  const from = left.length;
  const to = from + replace.length;
  if (localScan.mid[from] === 1 || localScan.mid[to] === 1) return false;
  if ((localScan.depth[to] ?? 0) !== (baseScan.depth[end] ?? 0)) return false;
  return minDepth(localScan, from, to) >= (localScan.depth[from] ?? 0);
}

/** Whether applying this one change to `base` keeps every `{{`/`}}` pair and the nesting around it intact. */
export function isTokenSafe(base: string, change: { start: number; end: number; replace: string }): boolean {
  return tokenSafeIn(base, scan(base), change);
}

// ---- matching ---------------------------------------------------------------

/** Where `find` starts in `text`, overlapping occurrences counted; at most two. */
function occurrences(text: string, find: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(find); at !== -1 && found.length < 2; at = text.indexOf(find, at + 1)) {
    found.push(at);
  }
  return found;
}

const WHITESPACE = /\s/u;
/** R3.1: characters that fold one to one before a normalized match. */
const foldTo = (chars: string, to: string): [string, string][] => Array.from(chars, (c): [string, string] => [c, to]);
const FOLDS: ReadonlyMap<string, string> = new Map([
  ...foldTo('‘’‚‛′', "'"),
  ...foldTo('“”„‟″', '"'),
  ...foldTo('‐‑‒–—−', '-'),
]);

/** The text with each whitespace run as one space and quotes and dashes folded, and where each character came from. */
function normalize(text: string): { text: string; from: number[] } {
  let out = '';
  const from: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (!WHITESPACE.test(char)) {
      out += FOLDS.get(char) ?? char;
      from.push(i);
    } else if (!out.endsWith(' ')) {
      out += ' ';
      from.push(i);
    }
  }
  return { text: out, from };
}

type Match = Range | 'missing' | 'ambiguous';

/** Whether `offset` falls between the two halves of a surrogate pair of `text`. */
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * A passage that takes half of a character names nothing in the template: the
 * other half would be left unpaired outside the change, and its bytes miscounted.
 */
const wholeCharacters = (base: string, range: Range): Match => (
  splitsPair(base, range.start) || splitsPair(base, range.end) ? 'missing' : range);

/** R3.1: the one passage `find` names in `base`, exactly, else in normalized form. */
function match(base: string, find: string, normalizedBase: () => ReturnType<typeof normalize>): Match {
  const exact = occurrences(base, find);
  if (exact.length > 1) return 'ambiguous';
  const [start] = exact;
  if (start !== undefined) return wholeCharacters(base, { start, end: start + find.length });
  const wanted = normalize(find).text.trim();
  if (wanted === '') return 'missing';
  const normalized = normalizedBase();
  const found = occurrences(normalized.text, wanted);
  if (found.length > 1) return 'ambiguous';
  const [at] = found;
  if (at === undefined) return 'missing';
  // The find is trimmed, so both ends fall on non-whitespace characters of the base.
  const first = normalized.from[at] ?? 0;
  const last = normalized.from[at + wanted.length - 1] ?? first;
  return wholeCharacters(base, { start: first, end: last + 1 });
}

// ---- var-token widening -------------------------------------------------------

/** Every `{{var::…}}` token of `text`, at any nesting depth, as base offsets. */
function varTokens(text: string, offset = 0): Range[] {
  const out: Range[] = [];
  for (const token of findTokens(text)) {
    if (VAR_TOKEN_ANCHORED.test(token.text)) {
      out.push({ start: offset + token.start, end: offset + token.end });
    } else {
      out.push(...varTokens(token.text.slice(2, -2), offset + token.start + 2));
    }
  }
  return out;
}

/** R3.3: the range with each edge that lies strictly inside a var token moved to that token's edge. */
function widen(tokens: readonly Range[], range: Range): Range {
  let { start, end } = range;
  for (const token of tokens) {
    if (token.start < start && start < token.end) start = token.start;
    if (token.start < end && end < token.end) end = token.end;
  }
  return { start, end };
}

// ---- whole operations ---------------------------------------------------------

/** Unchanged text of the diff: base `[b0, b1)` reads as rewritten `[n0, n0 + b1 - b0)`. */
interface SameRun { b0: number; b1: number; n0: number }

type Decomposition = Edit[] | 'whole';

/**
 * R3.9: a whole rewrite as word hunks, each an aligned pair of a base range
 * and the slice of the rewritten body between the same unchanged edges.
 * 'whole' when one change over the whole base must stand instead.
 */
function decompose(base: string, rewritten: string, baseScan: Scan, tokens: readonly Range[], limits: Limits): Decomposition {
  const parts = diffWordsWithSpace(base, rewritten, { maxEditLength: WHOLE_DIFF_MAX_EDIT_LENGTH });
  if (parts === undefined) return 'whole';

  const baseWords = countWords(base);
  const keptWords = parts.reduce((sum, part) => (part.added || part.removed ? sum : sum + countWords(part.value)), 0);
  if (baseWords > LONG_BASE_WORDS && keptWords < MIN_KEPT_SHARE * baseWords) return 'whole';

  // Zero-length anchors at both ends map the text edges before and after any insertion there.
  const same: SameRun[] = [{ b0: 0, b1: 0, n0: 0 }];
  let hunks: Range[] = [];
  let open: Range | null = null;
  let b = 0;
  let n = 0;
  for (const part of parts) {
    const length = part.value.length;
    if (part.added) {
      open ??= { start: b, end: b };
      n += length;
    } else if (part.removed) {
      open ??= { start: b, end: b };
      b += length;
      open.end = b;
    } else {
      if (open) hunks.push(open);
      open = null;
      same.push({ b0: b, b1: b + length, n0: n });
      b += length;
      n += length;
    }
  }
  if (open) hunks.push(open);
  same.push({ b0: base.length, b1: base.length, n0: rewritten.length });

  // Before any insertion at the edge for a start, after it for an end.
  const mapStart = (p: number): number => {
    const run = same.find((r) => r.b0 <= p && p <= r.b1);
    return run ? run.n0 + p - run.b0 : 0;
  };
  const mapEnd = (p: number): number => {
    const run = same.findLast((r) => r.b0 <= p && p <= r.b1);
    return run ? run.n0 + p - run.b0 : rewritten.length;
  };
  const join = (a: Range, z: Range): Range => ({ start: Math.min(a.start, z.start), end: Math.max(a.end, z.end) });

  // (a) Hunks separated by at most two unchanged words merge.
  hunks = hunks.reduce<Range[]>((out, hunk) => {
    const last = out.at(-1);
    if (last && countWords(base.slice(last.end, hunk.start)) <= MERGE_GAP_WORDS) out[out.length - 1] = join(last, hunk);
    else out.push(hunk);
    return out;
  }, []);

  // (b) Widen to var-token edges; ranges that then overlap or touch merge.
  hunks = hunks
    .map((hunk) => widen(tokens, hunk))
    // A hunk edge never parts a surrogate pair: it steps out to the whole character.
    .map(({ start, end }) => ({ start: splitsPair(base, start) ? start - 1 : start, end: splitsPair(base, end) ? end + 1 : end }))
    .toSorted((x, y) => x.start - y.start)
    .reduce<Range[]>((out, hunk) => {
      const last = out.at(-1);
      if (last && hunk.start <= last.end) out[out.length - 1] = join(last, hunk);
      else out.push(hunk);
      return out;
    }, []);

  const edit = (range: Range): Edit => ({ ...range, replace: rewritten.slice(mapStart(range.start), mapEnd(range.end)) });
  const safe = (range: Range): boolean => tokenSafeIn(base, baseScan, edit(range));

  // (c) Left to right, an unsafe hunk merges with the next (the previous when last).
  let i = 0;
  while (i < hunks.length) {
    const hunk = hunks[i];
    if (!hunk || safe(hunk)) {
      i += 1;
      continue;
    }
    if (hunks.length === 1) return 'whole';
    const next = hunks[i + 1];
    if (next) {
      hunks.splice(i, 2, join(hunk, next));
    } else {
      const previous = hunks[i - 1];
      if (!previous) return 'whole';
      hunks.splice(i - 1, 2, join(previous, hunk));
      i -= 1;
    }
  }

  const edits = hunks.map(edit).filter((e) => e.replace !== base.slice(e.start, e.end));
  if (edits.length === 0) return 'whole';
  const summed = edits.reduce(
    (sum, e) => ({ chars: sum.chars + growthChars(base, e), bytes: sum.bytes + growthBytes(base, e) }),
    { chars: 0, bytes: 0 },
  );
  if (!limits.fits(summed.chars, summed.bytes)) return 'whole';
  return edits;
}

// ---- placement ----------------------------------------------------------------

const growthChars = (base: string, e: Edit): number =>
  Math.max(0, codePoints(e.replace) - codePoints(base.slice(e.start, e.end)));
const growthBytes = (base: string, e: Edit): number =>
  Math.max(0, utf8Bytes(e.replace) - utf8Bytes(base.slice(e.start, e.end)));

interface Limits { fits: (chars: number, bytes: number) => boolean }

/** `text` with its leading and trailing whitespace runs replaced by those of `base`. */
function withOuterWhitespaceOf(base: string, text: string): string {
  const lead = base.slice(0, base.length - base.trimStart().length);
  const rest = base.slice(lead.length);
  const trail = rest.slice(rest.trimEnd().length);
  return `${lead}${text.trim()}${trail}`;
}

const conflicts = (a: Range, z: Range): boolean => a.start <= z.end && z.start <= a.end;

/** Places each operation against the base, in arrival order (R3). */
export function placeTemplateOperations(
  base: string,
  operations: readonly TemplateOperation[],
  options: PlaceOptions,
): TemplatePlacement {
  const baseScan = scan(base);
  const tokens = varTokens(base);
  const baseBytes = utf8Bytes(base);
  let normalizedBase: ReturnType<typeof normalize> | undefined;
  const normalized = () => (normalizedBase ??= normalize(base));

  const placed: TemplateChange[] = [];
  const unplaced: UnplacedTemplateChange[] = [];
  const warnings = new Set<string>();
  let wholeWhy: string | null = null;
  let wholePlaced = false;
  let grownChars = 0;
  let grownBytes = 0;
  const limits = (extraChars: number, extraBytes: number): boolean =>
    grownChars + extraChars <= options.maxGrowthChars && baseBytes + grownBytes + extraBytes <= options.maxBodyBytes;

  const accept = (edits: readonly Edit[], why: string, sanitizedWarnings: readonly string[]): void => {
    for (const e of edits) {
      placed.push({ id: 0, start: e.start, end: e.end, replace: e.replace, why });
      grownChars += growthChars(base, e);
      grownBytes += growthBytes(base, e);
    }
    for (const warning of sanitizedWarnings) warnings.add(warning);
  };

  for (const asWritten of operations) {
    // A lone surrogate cannot be stored as UTF-8; it reads as U+FFFD from here on.
    const operation = { ...asWritten, replace: asWritten.replace.toWellFormed() };
    const refuse = (replace: string, reason: UnplacedReason): void => {
      unplaced.push({ find: operation.find, replace, why: operation.why, reason });
    };

    const found: Match = operation.find === '' ? { start: 0, end: base.length } : match(base, operation.find, normalized);
    if (found === 'missing' || found === 'ambiguous') {
      refuse(options.sanitize(operation.replace).text, found);
      continue;
    }

    const whole = base.slice(0, found.start).trim() === '' && base.slice(found.end).trim() === '';
    if (whole) {
      // R3.9. The rewrite takes the base's own outer whitespace, so a model
      // that trims its answer does not produce whitespace-only changes.
      const sanitized = options.sanitize(withOuterWhitespaceOf(base, operation.replace));
      const all: Edit = { start: 0, end: base.length, replace: sanitized.text };
      if (sanitized.text === base) continue;
      if (wholePlaced || placed.length > 0) {
        refuse(sanitized.text, 'overlap');
        continue;
      }
      if (!limits(growthChars(base, all), growthBytes(base, all))) {
        refuse(sanitized.text, 'too_long');
        continue;
      }
      const hunks = decompose(base, sanitized.text, baseScan, tokens, { fits: limits });
      accept(hunks === 'whole' ? [all] : hunks, '', sanitized.warnings);
      wholePlaced = true;
      const why = operation.why.trim();
      if (why !== '') wholeWhy = why;
      continue;
    }

    // R3.3 to R3.8
    const range = widen(tokens, found);
    const widened = base.slice(range.start, found.start) + operation.replace + base.slice(found.end, range.end);
    const sanitized = options.sanitize(widened);
    const e: Edit = { ...range, replace: sanitized.text };
    if (e.replace === base.slice(e.start, e.end)) continue;
    if (!tokenSafeIn(base, baseScan, e)) {
      refuse(e.replace, 'splits_token');
      continue;
    }
    if (wholePlaced || placed.some((other) => conflicts(e, other))) {
      refuse(e.replace, 'overlap');
      continue;
    }
    if (!limits(growthChars(base, e), growthBytes(base, e))) {
      refuse(e.replace, 'too_long');
      continue;
    }
    accept([e], operation.why, sanitized.warnings);
  }

  const changes = placed
    .toSorted((a, z) => a.start - z.start)
    .map((change, id) => ({ ...change, id }));
  return { changes, unplaced, wholeWhy, warnings: [...warnings] };
}

// ---- application and checks ----------------------------------------------------

/** R3.11: the base with each accepted change spliced in, highest offset first. */
export function applyTemplateChanges(
  base: string,
  changes: readonly TemplateChange[],
  acceptedIds: Iterable<number>,
): string {
  const accepted = new Set(acceptedIds);
  return changes
    .filter((change) => accepted.has(change.id))
    .toSorted((a, z) => z.start - a.start)
    .reduce((out, change) => out.slice(0, change.start) + change.replace + out.slice(change.end), base);
}

/** R1.2: integer offsets within the base, id equal to index, sorted, neither overlapping nor touching. */
export function isTemplateChangeSet(baseLength: number, changes: readonly TemplateChange[]): boolean {
  return changes.every((change, index) => {
    const { id, start, end } = change;
    if (id !== index || !Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < 0 || start > end || end > baseLength) return false;
    const previous = changes[index - 1];
    return previous === undefined || previous.end < start;
  });
}

/** The word diff of two texts as runs, or undefined when it needs more than `maxEditLength` edits. */
export function diffWordRuns(before: string, after: string, maxEditLength: number): WordRun[] | undefined {
  const parts = diffWordsWithSpace(before, after, { maxEditLength });
  return parts?.map((part): WordRun => ({
    kind: part.added ? 'ins' : part.removed ? 'del' : 'same',
    text: part.value,
  }));
}
