import {
  countWords,
  diffWordRuns,
  type TemplateChange,
  type WordRun,
} from '@atelier/shared/template-rework';
import { findTokens } from '@atelier/shared/template-tokens';

/*
 * How a template body under review reads as tracked changes: the base cut at
 * each placed change, long unchanged stretches folded away, each change as a
 * word diff of the passage it replaces, and a note row per inline change at
 * the end of its sentence (spec template-rework-review R4.2 to R4.4).
 * Presentation only: the shared placement module owns which passage a change
 * replaces. Ported from Ephemera's rework/tracked.ts. Segmentation depends on
 * the base and the changes alone, so a review computes it once and decisions
 * never recompute it.
 */

export type Segment =
  | { kind: 'same'; start: number; text: string }
  /** Unchanged text folded behind "Show N unchanged words". */
  | { kind: 'fold'; start: number; text: string; words: number }
  | {
    kind: 'change';
    change: TemplateChange;
    /** The base passage the change replaces. */
    find: string;
    runs: readonly WordRun[];
    /**
     * `inline` interleaves struck and inserted words, followed later by a
     * `notes` row; `block` shows the replacement as one proposed passage with
     * the removed text apart, its note as the block's last line.
     */
    mode: 'inline' | 'block';
  }
  /** The note rows of these inline changes, stacked in text order. */
  | { kind: 'notes'; ids: readonly number[] };

interface SegmentOptions {
  /** Unchanged runs longer than this many words fold away, keeping context beside changes. */
  collapseWords: number;
}

/** Context beside a change: its sentence when that is at most this many words. */
const CONTEXT_SENTENCE_WORDS = 40;
/** Context beside a change whose sentence is longer. Also the least a fold may hide. */
const CONTEXT_WORDS = 12;
/** A change is a block only when passage and replacement together pass this many words... */
const BLOCK_WORDS = 80;
/** ...and the replacement, or the diff's kept words, fall below this share of the passage. */
const BLOCK_KEPT = 0.4;
/** The word diff's budget; past it a large change reads as a block. */
export const DIFF_MAX_EDIT_LENGTH = 1000;
/** A note never stands inside a token that nests no other token and is at most this long. */
const LEAF_TOKEN_MAX_CHARS = 120;

const WORD = /\S+/gu;
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

interface Range { start: number; end: number }

type ChangeSegment = Extract<Segment, { kind: 'change' }>;
type BaseSegment = Extract<Segment, { kind: 'same' | 'fold' }> | ChangeSegment;

/** The passage struck, then the replacement inserted, without empty runs. */
const struckThenInserted = (find: string, replace: string): WordRun[] => [
  ...(find === '' ? [] : [{ kind: 'del' as const, text: find }]),
  ...(replace === '' ? [] : [{ kind: 'ins' as const, text: replace }]),
];

/** R4.2: a change's runs and the form it reads in. */
function track(find: string, replace: string): { runs: WordRun[]; mode: 'inline' | 'block' } {
  // A pure insertion or removal is one marked or one struck run, always inline.
  if (find === '' || replace === '') return { runs: struckThenInserted(find, replace), mode: 'inline' };
  const findWords = countWords(find);
  const replaceWords = countWords(replace);
  const large = findWords + replaceWords > BLOCK_WORDS;
  if (large && replaceWords < findWords * BLOCK_KEPT) {
    return { runs: struckThenInserted(find, replace), mode: 'block' };
  }
  const runs = diffWordRuns(find, replace, DIFF_MAX_EDIT_LENGTH);
  if (runs === undefined) return { runs: struckThenInserted(find, replace), mode: large ? 'block' : 'inline' };
  if (!large) return { runs, mode: 'inline' };
  const kept = runs.reduce((sum, run) => sum + (run.kind === 'same' ? countWords(run.text) : 0), 0);
  return { runs, mode: kept < findWords * BLOCK_KEPT ? 'block' : 'inline' };
}

/** Every `{{…}}` token at any depth that nests no other token and is short enough to keep whole. */
function leafTokens(text: string, at = 0): Range[] {
  return findTokens(text).flatMap((token) => {
    const start = at + token.start;
    const inner = token.text.slice(2, -2);
    if (findTokens(inner).length > 0) return leafTokens(inner, start + 2);
    return token.text.length <= LEAF_TOKEN_MAX_CHARS ? [{ start, end: start + token.text.length }] : [];
  });
}

/** The range strictly around `offset`, if any. */
const around = (ranges: readonly Range[], offset: number): Range | undefined =>
  ranges.find((range) => range.start < offset && offset < range.end);

/** The fold that hides the text before `offset`, if any. */
const foldBefore = (folds: readonly Range[], offset: number): Range | undefined =>
  folds.find((fold) => fold.start < offset && offset <= fold.end);

/** Offset where the nearest `count` words of `text` end, counted from its start. */
function afterWords(text: string, count: number): number {
  let end = 0;
  let seen = 0;
  for (const match of text.matchAll(WORD)) {
    end = match.index + match[0].length;
    seen += 1;
    if (seen === count) break;
  }
  return end;
}

/** Offset where the nearest `count` words of `text` start, counted from its end. */
function beforeWords(text: string, count: number): number {
  const starts = [...text.matchAll(WORD)].map((match) => match.index);
  return starts[Math.max(0, starts.length - count)] ?? text.length;
}

/**
 * Where the context after a change ends in the run that follows it: the rest
 * of the change's sentence when short enough, else its first words. Sentence
 * boundaries include line breaks, so context never runs into the next paragraph.
 */
function leadingContext(run: string): number {
  const first = sentences.segment(run)[Symbol.iterator]().next();
  if (first.done === true) return 0;
  const sentence = first.value.segment;
  return countWords(sentence) <= CONTEXT_SENTENCE_WORDS ? sentence.length : afterWords(sentence, CONTEXT_WORDS);
}

/** Where the context before a change starts in the run that precedes it; as `leadingContext`. */
function trailingContext(run: string): number {
  let last: Intl.SegmentData | undefined;
  for (const segment of sentences.segment(run)) last = segment;
  if (last === undefined) return run.length;
  const sentence = last.segment;
  return countWords(sentence) <= CONTEXT_SENTENCE_WORDS
    ? last.index
    : last.index + beforeWords(sentence, CONTEXT_WORDS);
}

/**
 * R4.3: the unchanged run `[start, end)` of the base, folded when long, with
 * context kept on the sides that touch a change. A fold edge never cuts a
 * leaf token, so a note clamped to a fold's start stays outside tokens too.
 */
function unchanged(
  base: string,
  { start, end }: Range,
  touches: { after: boolean; before: boolean },
  collapseWords: number,
  leaves: readonly Range[],
): BaseSegment[] {
  const run = base.slice(start, end);
  if (run === '') return [];
  if (countWords(run) <= collapseWords) return [{ kind: 'same', start, text: run }];
  let from = start + (touches.after ? leadingContext(run) : 0);
  from = Math.min(end, around(leaves, from)?.end ?? from);
  let to = Math.max(from, touches.before ? start + trailingContext(run) : end);
  to = Math.max(from, around(leaves, to)?.start ?? to);
  const hidden = base.slice(from, to);
  const words = countWords(hidden);
  // Folding away a few words costs the reader more than it saves.
  if (words < CONTEXT_WORDS) return [{ kind: 'same', start, text: run }];
  const segments: BaseSegment[] = [];
  if (from > start) segments.push({ kind: 'same', start, text: base.slice(start, from) });
  segments.push({ kind: 'fold', start: from, text: hidden, words });
  if (to < end) segments.push({ kind: 'same', start: to, text: base.slice(to, end) });
  return segments;
}

/**
 * R4.4: where each inline change's note row stands, as an offset into the
 * base: the end of the sentence holding the change's last character, before
 * the line break that closes it, never before the change's end, moved past a
 * leaf token it would fall inside. A note whose place lies past a later
 * change's start waits for that change's note (a block's waits at the block's
 * start), so notes sharing a place stack in text order. A note inside or at
 * the end of a fold moves to where the fold begins, so it never stands behind
 * hidden text.
 */
function noteOffsets(
  base: string,
  segments: readonly ChangeSegment[],
  folds: readonly Range[],
  leaves: readonly Range[],
): number[] {
  const bounds = [...sentences.segment(base)];
  const places = segments.map(({ change, mode }) => {
    if (mode === 'block') return change.start;
    if (change.end >= base.length) return base.length;
    const last = change.end > change.start ? change.end - 1 : change.start;
    const sentence = bounds.find(({ index, segment }) => index <= last && last < index + segment.length);
    if (sentence === undefined) return change.end;
    const end = sentence.index + sentence.segment.length;
    // A line break stays after the row, so a paragraph break still reads as one.
    const space = /\s*$/u.exec(sentence.segment)?.[0] ?? '';
    const at = Math.max(change.end, space.includes('\n') ? end - space.length : end);
    return around(leaves, at)?.end ?? at;
  });
  for (let index = places.length - 2; index >= 0; index -= 1) {
    const next = segments[index + 1];
    const later = places[index + 1];
    const place = places[index];
    if (next !== undefined && later !== undefined && place !== undefined && place > next.change.start) {
      places[index] = later;
    }
  }
  return places.map((place) => foldBefore(folds, place)?.start ?? place);
}

/**
 * The base as segments: unchanged runs (folded per R4.3), one segment per
 * change, and the note rows of inline changes (R4.4), in text order.
 * Concatenating the text of `same` and `fold` segments and the `find` of
 * `change` segments gives back `base`. `changes` satisfy R1.2: sorted by
 * start, neither overlapping nor touching.
 */
export function segmentTemplate(
  base: string,
  changes: readonly TemplateChange[],
  options: SegmentOptions,
): Segment[] {
  const leaves = leafTokens(base);
  const pieces: BaseSegment[] = [];
  const changeSegments: ChangeSegment[] = [];
  let offset = 0;
  for (const [index, change] of changes.entries()) {
    pieces.push(...unchanged(base, { start: offset, end: change.start }, { after: index > 0, before: true }, options.collapseWords, leaves));
    const find = base.slice(change.start, change.end);
    const segment: ChangeSegment = { kind: 'change', change, find, ...track(find, change.replace) };
    pieces.push(segment);
    changeSegments.push(segment);
    offset = change.end;
  }
  pieces.push(...unchanged(base, { start: offset, end: base.length }, { after: changes.length > 0, before: false }, options.collapseWords, leaves));

  const folds = pieces.flatMap((piece) => (piece.kind === 'fold' ? [{ start: piece.start, end: piece.start + piece.text.length }] : []));
  const places = noteOffsets(base, changeSegments, folds, leaves);
  const notesAt = new Map<number, number[]>();
  for (const [index, segment] of changeSegments.entries()) {
    const place = places[index];
    if (segment.mode === 'block' || place === undefined) continue;
    notesAt.set(place, [...(notesAt.get(place) ?? []), segment.change.id]);
  }

  const out: Segment[] = [];
  const flush = (at: number, beforeId = Infinity) => {
    const ids = notesAt.get(at);
    if (ids === undefined) return;
    const due = ids.filter((id) => id < beforeId);
    if (due.length === 0) return;
    out.push({ kind: 'notes', ids: due });
    const rest = ids.filter((id) => id >= beforeId);
    if (rest.length === 0) notesAt.delete(at);
    else notesAt.set(at, rest);
  };
  for (const piece of pieces) {
    if (piece.kind === 'change') {
      // Where an insertion stands, only earlier changes' notes precede it; its own follows it.
      flush(piece.change.start, piece.change.id);
      out.push(piece);
      continue;
    }
    flush(piece.start);
    if (piece.kind === 'fold') {
      out.push(piece);
      continue;
    }
    // A same run splits where notes stand inside it.
    const end = piece.start + piece.text.length;
    const cuts = [...notesAt.keys()].filter((at) => piece.start < at && at < end).toSorted((a, z) => a - z);
    let from = piece.start;
    for (const cut of cuts) {
      out.push({ kind: 'same', start: from, text: base.slice(from, cut) });
      flush(cut);
      from = cut;
    }
    out.push({ kind: 'same', start: from, text: base.slice(from, end) });
  }
  // Notes at the end of the base, and defensively any left over, close the text.
  for (const at of [...notesAt.keys()].toSorted((a, z) => a - z)) flush(at);
  return out;
}
