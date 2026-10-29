import { parseVarToken, type PromptTemplate, type TagDimension, type VariableList, type VariableOption } from '@atelier/shared';
import type { ResolveOpts, ResolveResult } from '@atelier/shared/prompt-resolver';
import { conflictingDimensions, groupTagsByDimension, type TagsByDimension } from '@atelier/shared/tag-coherence';
import { findClose, splitDepth0, stripTemplateComments } from '@atelier/shared/template-tokens';
import { occurrencePin, pinsFromEntries } from './promptPins';
import { occurrenceKeyOf } from './subjectKey';

export interface AxisEvaluation {
  option: VariableOption;
  admissible: boolean;
  blockedBy?: {
    occurrenceKey: string;
    listName: string;
    optionId: string;
    dimensionId: string;
    label: string;
  };
}

export interface VarOccurrence {
  key: string;
  listName: string;
  subject: number | null;
}

const MAX_PASSES = 8;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function choice<T>(items: readonly T[], rng: () => number): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

export function weightedChoice<T extends { weight: number }>(items: readonly T[], rng: () => number): T | undefined {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];
  let total = 0;
  for (const item of items) total += item.weight;
  if (total <= 0) return items[0];
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight;
    if (r < 0) return item;
  }
  return items[items.length - 1];
}

export function weightedShuffle<T extends { weight: number }>(
  items: readonly T[],
  rng: () => number,
): T[] {
  const keyed = items.map((item) => {
    const u = 1 - rng();
    const key = -Math.log(u) / Math.max(1, item.weight);
    return { item, key };
  });
  keyed.sort((a, b) => a.key - b.key);
  return keyed.map((k) => k.item);
}

function buildTagIndex(dims: readonly TagDimension[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const dim of dims) {
    for (const tag of dim.tags) {
      index.set(tag.id, dim.id);
    }
  }
  return index;
}

export function firstConflictDimension(
  a: VariableOption,
  b: VariableOption,
  index: ResolveIndex,
): string | null {
  const aTags = index.optionTagsById.get(a.id);
  const bTags = index.optionTagsById.get(b.id);
  if (!aTags || !bTags) return null;
  for (const dimensionId of conflictingDimensions(aTags, bTags)) return dimensionId;
  return null;
}

// Cross-subject pairs are unconstrained: two occurrences with DIFFERING
// non-null subjects never coerce coherence. A null subject (scene-level)
// bridges to every subject, so it is always checked.
function subjectsCohere(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  return a === b;
}

function findList(listName: string, lists: readonly VariableList[]): VariableList | undefined {
  return lists.find((list) => list.name === listName);
}

function findOption(list: VariableList, optionId: string): VariableOption | undefined {
  return list.options.find((option) => option.id === optionId);
}

export function collectVarOccurrences(text: string): VarOccurrence[] {
  const occurrences: VarOccurrence[] = [];
  const countByKey = new Map<string, number>();
  let i = 0;

  while (i < text.length) {
    const start = text.indexOf('{{var::', i);
    if (start === -1) break;
    const close = findClose(text, start + 2);
    if (close === -1) break;
    const inner = text.slice(start + '{{var::'.length, close).trim();
    const { listName, subject } = parseVarToken(inner);
    if (listName.length > 0) {
      const groupKey = subject === null ? listName : `${listName}@${subject}`;
      const n = countByKey.get(groupKey) ?? 0;
      occurrences.push({ key: occurrenceKeyOf(listName, subject, n), listName, subject });
      countByKey.set(groupKey, n + 1);
    }
    i = close + 2;
  }

  return occurrences;
}

export function occurrenceLabel(
  occurrences: readonly VarOccurrence[],
  occurrence: VarOccurrence,
): string {
  const siblings = occurrenceIndex(occurrences).groups.get(JSON.stringify([occurrence.listName, occurrence.subject]));
  if (siblings === undefined || siblings.count <= 1) return occurrence.listName;
  const position = siblings.positions.get(occurrence.key) ?? siblings.count;
  return `${occurrence.listName} · ${position} / ${siblings.count}`;
}

interface OccurrenceIndex {
  readonly occByKey: ReadonlyMap<string, string>;
  readonly subjectByKey: ReadonlyMap<string, number | null>;
  readonly groups: ReadonlyMap<string, { count: number; positions: Map<string, number> }>;
}

// Every axis reads the same immutable occurrence array. Build its lookup and
// label indexes once, rather than scanning the whole template for every row.
const occurrenceIndexes = new WeakMap<readonly VarOccurrence[], OccurrenceIndex>();

function occurrenceIndex(occurrences: readonly VarOccurrence[]): OccurrenceIndex {
  let index = occurrenceIndexes.get(occurrences);
  if (index !== undefined) return index;
  const occByKey = new Map<string, string>();
  const subjectByKey = new Map<string, number | null>();
  const groups = new Map<string, { count: number; positions: Map<string, number> }>();
  for (const occurrence of occurrences) {
    occByKey.set(occurrence.key, occurrence.listName);
    subjectByKey.set(occurrence.key, occurrence.subject);
    const key = JSON.stringify([occurrence.listName, occurrence.subject]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { count: 0, positions: new Map() };
      groups.set(key, group);
    }
    group.count += 1;
    if (!group.positions.has(occurrence.key)) group.positions.set(occurrence.key, group.count);
  }
  index = { occByKey, subjectByKey, groups };
  occurrenceIndexes.set(occurrences, index);
  return index;
}

function pinLabel(
  occurrences: readonly VarOccurrence[],
  pinKey: string,
  listName: string,
): string {
  const occ = occurrences.find((o) => o.key === pinKey);
  if (occ === undefined) return listName;
  return occurrenceLabel(occurrences, occ);
}

function pinKeyListName(
  pinKey: string,
  occByKey: ReadonlyMap<string, string>,
  lists: readonly VariableList[],
): string | undefined {
  const viaOcc = occByKey.get(pinKey);
  if (viaOcc !== undefined) return viaOcc;
  return findList(pinKey, lists) !== undefined ? pinKey : undefined;
}

// Library-derived invariants are cached by the immutable query-result array
// identities. Occurrence indexes use the same immutable-array ownership, so
// axis evaluation and sweep rolls reuse their snapshot's derived lookups.
export interface ResolveIndex {
  readonly tagToDim: Map<string, string>;
  readonly optionTagsById: Map<string, TagsByDimension<string>>;
  readonly occByKey: ReadonlyMap<string, string>;
  readonly subjectByKey: ReadonlyMap<string, number | null>;
}

interface ResolveIndexCore {
  readonly tagToDim: Map<string, string>;
  readonly optionTagsById: Map<string, TagsByDimension<string>>;
}

const resolveIndexCoreByDimensions = new WeakMap<
  readonly TagDimension[],
  WeakMap<readonly VariableList[], ResolveIndexCore>
>();

export function buildResolveIndex(
  occurrences: readonly VarOccurrence[],
  dims: readonly TagDimension[],
  lists: readonly VariableList[],
): ResolveIndex {
  let byLists = resolveIndexCoreByDimensions.get(dims);
  if (byLists === undefined) {
    byLists = new WeakMap();
    resolveIndexCoreByDimensions.set(dims, byLists);
  }
  let core = byLists.get(lists);
  if (core === undefined) {
    const tagToDim = buildTagIndex(dims);
    const parentByTagId = new Map<string, string>();
    for (const dimension of dims) {
      for (const tag of dimension.tags) {
        if (tag.parentId && tagToDim.get(tag.parentId) === dimension.id) {
          parentByTagId.set(tag.id, tag.parentId);
        }
      }
    }
    const closureByTagId = new Map<string, readonly string[]>();
    for (const tagId of tagToDim.keys()) {
      const closure: string[] = [];
      const seen = new Set<string>();
      let current: string | undefined = tagId;
      while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        closure.push(current);
        current = parentByTagId.get(current);
      }
      closureByTagId.set(tagId, closure);
    }
    const expand = (tagIds: readonly string[]): string[] => [
      ...new Set(tagIds.flatMap((tagId) => closureByTagId.get(tagId) ?? [tagId])),
    ];
    const optionTagsById = new Map<string, TagsByDimension<string>>();
    for (const list of lists) {
      for (const option of list.options) {
        const required = expand(option.tagIds);
        const excluded = expand(option.excludeTagIds ?? []);
        optionTagsById.set(option.id, {
          require: groupTagsByDimension(required, tagToDim),
          exclude: groupTagsByDimension(excluded, tagToDim),
        });
      }
    }
    core = { tagToDim, optionTagsById };
    byLists.set(lists, core);
  }
  return {
    ...core,
    occByKey: occurrenceIndex(occurrences).occByKey,
    subjectByKey: occurrenceIndex(occurrences).subjectByKey,
  };
}

export function evaluateAxis(
  occurrence: VarOccurrence,
  occurrences: readonly VarOccurrence[],
  pins: Readonly<Record<string, string>>,
  lists: readonly VariableList[],
  dims: readonly TagDimension[],
): AxisEvaluation[] {
  return evaluateAxisWith(occurrence, occurrences, pins, lists, buildResolveIndex(occurrences, dims, lists));
}

function evaluateAxisWith(
  occurrence: VarOccurrence,
  occurrences: readonly VarOccurrence[],
  pins: Readonly<Record<string, string>>,
  lists: readonly VariableList[],
  index: ResolveIndex,
): AxisEvaluation[] {
  const list = findList(occurrence.listName, lists);
  if (list === undefined) return [];

  const { occByKey, subjectByKey } = index;
  const pinnedOptions: { pinKey: string; listName: string; subject: number | null; option: VariableOption }[] = [];

  for (const [pinKey, optionId] of Object.entries(pins)) {
    if (pinKey === occurrence.key || pinKey === occurrence.listName) continue;
    const pinnedListName = pinKeyListName(pinKey, occByKey, lists);
    if (pinnedListName === undefined) continue;
    const pinnedList = findList(pinnedListName, lists);
    if (pinnedList === undefined) continue;
    const option = findOption(pinnedList, optionId);
    if (option === undefined) continue;
    pinnedOptions.push({ pinKey, listName: pinnedListName, subject: subjectByKey.get(pinKey) ?? null, option });
  }

  return list.options.map((option) => {
    for (const pinned of pinnedOptions) {
      if (!subjectsCohere(occurrence.subject, pinned.subject)) continue;
      const dimensionId = firstConflictDimension(option, pinned.option, index);
      if (dimensionId !== null) {
        return {
          option,
          admissible: false,
          blockedBy: {
            occurrenceKey: pinned.pinKey,
            listName: pinned.listName,
            optionId: pinned.option.id,
            dimensionId,
            label: pinLabel(occurrences, pinned.pinKey, pinned.listName),
          },
        };
      }
    }
    return { option, admissible: true };
  });
}

export function selectableOptions(
  occurrence: VarOccurrence,
  occurrences: readonly VarOccurrence[],
  pins: Record<string, string>,
  lists: readonly VariableList[],
  dims: readonly TagDimension[],
): VariableOption[] {
  return selectableOptionsWith(occurrence, occurrences, pins, lists, buildResolveIndex(occurrences, dims, lists));
}

function admissibleOptionsWith(
  occurrence: VarOccurrence,
  occurrences: readonly VarOccurrence[],
  pins: Record<string, string>,
  lists: readonly VariableList[],
  index: ResolveIndex,
): VariableOption[] {
  return evaluateAxisWith(occurrence, occurrences, pins, lists, index)
    .filter((evaluation) => evaluation.admissible)
    .map((evaluation) => evaluation.option);
}

function selectableOptionsWith(
  occurrence: VarOccurrence,
  occurrences: readonly VarOccurrence[],
  pins: Record<string, string>,
  lists: readonly VariableList[],
  index: ResolveIndex,
): VariableOption[] {
  return admissibleOptionsWith(occurrence, occurrences, pins, lists, index)
    .filter((option) => option.weight > 0);
}

function assignmentToPins(assignment: Map<string, VariableOption>): Record<string, string> {
  return pinsFromEntries([...assignment].map(([key, option]) => [key, option.id] as const));
}

// Deterministic bound on the constraint search one resolve may do. A unit is
// one option checked against one assigned axis while computing a domain, so
// the expensive per-node domain evaluation is what gets charged. Pigeonhole
// tag constraints otherwise backtrack factorially inside picker render.
const SOLVER_WORK_BUDGET = 200_000;
// Search depth equals the number of unpinned axes; past this the search is
// skipped rather than recursing that deep.
const MAX_SOLVER_DEPTH = 64;
// Separate bound, in the same units, for the greedy fallback that runs after
// the search gave up or proved no combination exists.
const FALLBACK_WORK_BUDGET = 200_000;

interface SolverBudget {
  remaining: number;
  exhausted: boolean;
}

function selectNextAxis(
  remaining: readonly VarOccurrence[],
  assignment: Map<string, VariableOption>,
  occurrences: readonly VarOccurrence[],
  lists: readonly VariableList[],
  index: ResolveIndex,
  budget: SolverBudget,
): { occurrence: VarOccurrence; domain: VariableOption[] } | null {
  const pins = assignmentToPins(assignment);
  let best: { occurrence: VarOccurrence; domain: VariableOption[] } | null = null;

  for (const occurrence of remaining) {
    const cost = 1 + (findList(occurrence.listName, lists)?.options.length ?? 0) * assignment.size;
    if (cost > budget.remaining) {
      budget.remaining = 0;
      budget.exhausted = true;
      return null;
    }
    budget.remaining -= cost;
    const domain = selectableOptionsWith(occurrence, occurrences, pins, lists, index);
    if (best === null || domain.length < best.domain.length) {
      best = { occurrence, domain };
    }
  }

  return best;
}

// Returns null both when no combination exists and when the budget ran out;
// `budget.exhausted` tells the two apart.
function solveUnpinnedAxes(
  remaining: readonly VarOccurrence[],
  assignment: Map<string, VariableOption>,
  occurrences: readonly VarOccurrence[],
  lists: readonly VariableList[],
  index: ResolveIndex,
  rng: () => number,
  budget: SolverBudget,
): Map<string, VariableOption> | null {
  if (remaining.length === 0) return assignment;

  const next = selectNextAxis(remaining, assignment, occurrences, lists, index, budget);
  if (next === null || next.domain.length === 0) return null;

  const rest = remaining.filter((o) => o.key !== next.occurrence.key);
  for (const option of weightedShuffle(next.domain, rng)) {
    const candidate = new Map(assignment);
    candidate.set(next.occurrence.key, option);
    const solved = solveUnpinnedAxes(rest, candidate, occurrences, lists, index, rng, budget);
    if (solved !== null) return solved;
    if (budget.exhausted) return null;
  }

  return null;
}

function sanitizePins(
  pins: Record<string, string>,
  occurrences: readonly VarOccurrence[],
  lists: readonly VariableList[],
  warnings: string[],
): Map<string, VariableOption> {
  const sanitized = new Map<string, VariableOption>();
  const warnedMissing = new Set<string>();
  const warnedCollision = new Set<string>();

  for (const occ of occurrences) {
    // A list literally named like an occurrence key (e.g. "Color#0") makes
    // pins[occ.key] ambiguous with that list's bare-name pin. Drop the
    // ambiguous occurrence-key form and use only the unambiguous bare-name
    // pin, surfacing the collision rather than risk applying a foreign
    // list's pin to this occurrence.
    const occKeyCollides = findList(occ.key, lists) !== undefined;
    if (occKeyCollides && !warnedCollision.has(occ.key)) {
      warnings.push(`occurrence key collides with a variable list name: ${occ.key}`);
      warnedCollision.add(occ.key);
    }
    const optionId = occurrencePin(pins, occKeyCollides ? undefined : occ.key, occ.listName);
    if (optionId === undefined) continue;
    const list = findList(occ.listName, lists);
    if (list === undefined) continue;
    const option = findOption(list, optionId);
    if (option === undefined) {
      if (!warnedMissing.has(occ.listName)) {
        warnings.push(`pinned option no longer exists for list: ${occ.listName}`);
        warnedMissing.add(occ.listName);
      }
    } else {
      sanitized.set(occ.key, option);
    }
  }

  return sanitized;
}

// Bound on the pinned-conflict check, in compared pairs of distinct pinned
// (option, subject) groups. Axes pinned alike share one group, so a huge
// repeated body pinned to one option costs a single comparison.
const PIN_CONFLICT_WORK_BUDGET = 200_000;
// Conflicting pinned pairs named individually; the rest are counted.
const MAX_PIN_CONFLICT_WARNINGS = 20;

interface PinGroup {
  readonly option: VariableOption;
  readonly subject: number | null;
  // Pin keys with their assignment positions, in assignment order.
  readonly members: { readonly key: string; readonly position: number }[];
}

function warnConflictingPins(
  assignment: Map<string, VariableOption>,
  occurrences: readonly VarOccurrence[],
  index: ResolveIndex,
  warnings: string[],
): void {
  const { occByKey, subjectByKey } = index;
  // The verdict depends only on the two options and their subjects, so every
  // pair drawn from the same two groups shares it.
  const groups: PinGroup[] = [];
  const groupById = new Map<string, PinGroup>();
  let position = 0;
  for (const [key, option] of assignment) {
    const subject = subjectByKey.get(key) ?? null;
    const id = JSON.stringify([subject, option.id]);
    let group = groupById.get(id);
    if (group === undefined) {
      group = { option, subject, members: [] };
      groupById.set(id, group);
      groups.push(group);
    }
    group.members.push({ key, position });
    position += 1;
  }

  const label = (key: string): string => pinLabel(occurrences, key, occByKey.get(key) ?? key);
  let listed = 0;
  let unlisted = 0;
  const report = (left: PinGroup, right: PinGroup, dimensionId: string): void => {
    const total = left === right
      ? (left.members.length * (left.members.length - 1)) / 2
      : left.members.length * right.members.length;
    let named = 0;
    for (let i = 0; i < left.members.length && listed < MAX_PIN_CONFLICT_WARNINGS; i++) {
      const leftMember = left.members[i];
      if (leftMember === undefined) continue;
      const rightMembers = left === right ? right.members.slice(i + 1) : right.members;
      for (const rightMember of rightMembers) {
        if (listed >= MAX_PIN_CONFLICT_WARNINGS) break;
        const leftFirst = leftMember.position < rightMember.position;
        const firstKey = leftFirst ? leftMember.key : rightMember.key;
        const secondKey = leftFirst ? rightMember.key : leftMember.key;
        warnings.push(`pinned options conflict: ${label(firstKey)} and ${label(secondKey)} on dimension ${dimensionId}`);
        listed += 1;
        named += 1;
      }
    }
    unlisted += total - named;
  };

  let workRemaining = PIN_CONFLICT_WORK_BUDGET;
  let limited = false;
  for (let i = 0; i < groups.length && !limited; i++) {
    const left = groups[i];
    if (left === undefined) continue;
    for (let j = i; j < groups.length; j++) {
      const right = groups[j];
      if (right === undefined) continue;
      // A group pairs with itself only when two axes share it.
      if (left === right && left.members.length < 2) continue;
      if (workRemaining === 0) {
        limited = true;
        break;
      }
      workRemaining -= 1;
      if (!subjectsCohere(left.subject, right.subject)) continue;
      const dimensionId = firstConflictDimension(left.option, right.option, index);
      if (dimensionId !== null) report(left, right, dimensionId);
    }
  }

  if (unlisted > 0) warnings.push(`pinned options conflict: ${unlisted} more conflicting pinned pairs not listed`);
  // Unchecked pairs proved nothing either way.
  if (limited) warnings.push('pinned conflict check limit reached - some pinned picks may conflict; unpin an axis or relax tags');
}

function solveAxes(
  occurrences: readonly VarOccurrence[],
  lists: readonly VariableList[],
  dims: readonly TagDimension[],
  opts: ResolveOpts,
  warnings: string[],
  rng: () => number,
): Map<string, VariableOption> {
  const sanitizedPins = sanitizePins(opts.pins, occurrences, lists, warnings);
  const knownOccurrences = occurrences.filter((o) => findList(o.listName, lists) !== undefined);
  const assignment = new Map<string, VariableOption>();
  const index = buildResolveIndex(occurrences, dims, lists);

  for (const occurrence of knownOccurrences) {
    const pinned = sanitizedPins.get(occurrence.key);
    if (pinned !== undefined) assignment.set(occurrence.key, pinned);
  }
  warnConflictingPins(assignment, occurrences, index, warnings);

  const remaining = knownOccurrences.filter((o) => !assignment.has(o.key));
  const budget: SolverBudget = { remaining: SOLVER_WORK_BUDGET, exhausted: remaining.length > MAX_SOLVER_DEPTH };
  const solved = budget.exhausted
    ? null
    : solveUnpinnedAxes(remaining, assignment, occurrences, lists, index, rng, budget);
  if (solved !== null) return solved;

  // An exhausted search proved nothing, so it must not claim "no combination".
  warnings.push(budget.exhausted
    ? 'constraint search limit reached - picks may conflict; pin an axis or relax tags'
    : 'no coherent combination - relax tags or unpin an axis');
  const fallback = new Map(assignment);
  // The greedy fallback is charged like the search, against its own budget.
  // Past it, each remaining slot takes a seeded positive-weight pick without
  // the coherence check, so a huge repeated-axis body stays linear.
  let fallbackRemaining = FALLBACK_WORK_BUDGET;
  let fallbackLimited = false;
  for (const occurrence of remaining) {
    const options = findList(occurrence.listName, lists)?.options ?? [];
    const positive = options.filter((candidate) => candidate.weight > 0);
    const cost = 1 + options.length * fallback.size;
    if (!fallbackLimited && cost > fallbackRemaining) {
      fallbackLimited = true;
      warnings.push('coherence check limit reached - remaining picks ignore tag constraints; pin an axis or relax tags');
    }
    let option: VariableOption | undefined;
    if (fallbackLimited) {
      option = weightedChoice(positive, rng);
    } else {
      fallbackRemaining -= cost;
      const domain = positive.filter((candidate) => coheresWithAssignment(occurrence, candidate, fallback, index));
      option = weightedChoice(domain, rng) ?? positive[0];
    }
    if (option !== undefined) fallback.set(occurrence.key, option);
  }
  return fallback;
}

// Same admissibility as evaluateAxisWith, read straight from the assignment so
// the fallback skips rebuilding a pin record and re-finding each pinned option.
function coheresWithAssignment(
  occurrence: VarOccurrence,
  option: VariableOption,
  assignment: ReadonlyMap<string, VariableOption>,
  index: ResolveIndex,
): boolean {
  for (const [key, assigned] of assignment) {
    if (key === occurrence.listName) continue;
    if (!subjectsCohere(occurrence.subject, index.subjectByKey.get(key) ?? null)) continue;
    if (firstConflictDimension(option, assigned, index) !== null) return false;
  }
  return true;
}

function replaceVariables(
  text: string,
  lists: readonly VariableList[],
  picks: Map<string, VariableOption>,
  warnings: string[],
): string {
  const warnedUnknown = new Set<string>();
  const warnedUnresolved = new Set<string>();
  const countByName = new Map<string, number>();
  let out = '';
  let i = 0;

  while (i < text.length) {
    if (text.slice(i, i + '{{var::'.length) !== '{{var::') {
      const char = text[i];
      if (char !== undefined) out += char;
      i += 1;
      continue;
    }

    const close = findClose(text, i + 2);
    if (close === -1) {
      out += text.slice(i);
      break;
    }

    const literal = text.slice(i, close + 2);
    const inner = text.slice(i + '{{var::'.length, close).trim();
    const { listName, subject } = parseVarToken(inner);
    if (listName.length === 0) {
      if (!warnedUnknown.has(listName)) {
        warnings.push(`unknown variable list: ${listName}`);
        warnedUnknown.add(listName);
      }
      out += literal;
      i = close + 2;
      continue;
    }

    const groupKey = subject === null ? listName : `${listName}@${subject}`;
    const n = countByName.get(groupKey) ?? 0;
    countByName.set(groupKey, n + 1);
    const key = occurrenceKeyOf(listName, subject, n);
    const list = findList(listName, lists);
    if (list === undefined) {
      if (!warnedUnknown.has(listName)) {
        warnings.push(`unknown variable list: ${listName}`);
        warnedUnknown.add(listName);
      }
      out += literal;
    } else {
      const pick = picks.get(key);
      if (pick === undefined) {
        if (!warnedUnresolved.has(listName)) {
          warnings.push(`no option resolved for variable list: ${listName}`);
          warnedUnresolved.add(listName);
        }
        out += literal;
      } else {
        out += pick.value;
      }
    }
    i = close + 2;
  }

  return out;
}

interface RawVarToken {
  readonly start: number;
  readonly end: number;
  readonly listName: string;
  readonly subject: number | null;
}

// A placeholder must be inert to the macro pass: NUL cannot collide with body
// text, and it carries no `::` / `,` that splitDepth0 could read as a branch
// separator — every macro keeps its branch count, and so its rng draw. Built
// via fromCharCode because a literal control char trips no-control-regex and
// makes the source file binary to grep.
const PLACEHOLDER_DELIM = String.fromCharCode(0);

// Same walker as collectVarOccurrences, but over the RAW template body and
// keeping each token's span so it can be rewritten in place. Malformed tokens
// (empty list name) are skipped exactly like collectVarOccurrences skips them,
// so the two agree on what counts as an occurrence.
function collectRawVarTokens(body: string): RawVarToken[] {
  const tokens: RawVarToken[] = [];
  let i = 0;
  while (i < body.length) {
    const start = body.indexOf('{{var::', i);
    if (start === -1) break;
    const close = findClose(body, start + 2);
    if (close === -1) break;
    const inner = body.slice(start + '{{var::'.length, close).trim();
    const { listName, subject } = parseVarToken(inner);
    if (listName.length > 0) tokens.push({ start, end: close + 2, listName, subject });
    i = close + 2;
  }
  return tokens;
}

// Which raw token ends up at which occurrence key once macros are resolved.
// Occurrence keys are positional over the MACRO-RESOLVED body, so a {{var::}}
// sitting in an un-picked {{random::}} branch has no key at all and every later
// same-list token shifts index. Reproduce that numbering without discarding the
// raw body: stand each token up as a placeholder, run the identical macro pass
// at the same seed (macro picks never depend on pins), then read the surviving
// placeholders in order. A token whose placeholder did not survive lives in an
// un-picked branch and stays keyless.
function keysByRawToken(body: string, tokens: readonly RawVarToken[], opts: ResolveOpts): Map<number, string> {
  let placeheld = '';
  let cursor = 0;
  tokens.forEach((token, index) => {
    placeheld += body.slice(cursor, token.start);
    placeheld += `${PLACEHOLDER_DELIM}${index}${PLACEHOLDER_DELIM}`;
    cursor = token.end;
  });
  placeheld += body.slice(cursor);

  // A fresh budget consumed in the same order as resolveText's pre-pass, so
  // limited rolls land identically and placeholder numbering stays aligned.
  const resolved = resolveMacros(placeheld, opts, mulberry32(opts.seed), createMacroBudget());
  const keys = new Map<number, string>();
  const countByName = new Map<string, number>();
  let i = 0;
  while (i < resolved.length) {
    const start = resolved.indexOf(PLACEHOLDER_DELIM, i);
    if (start === -1) break;
    const end = resolved.indexOf(PLACEHOLDER_DELIM, start + 1);
    if (end === -1) break;
    i = end + 1;
    const digits = resolved.slice(start + 1, end);
    // Guard the empty slice: Number('') is 0, which would hand token 0 a key it
    // never earned if a macro ever left two delimiters adjacent.
    const index = /^\d+$/.test(digits) ? Number(digits) : -1;
    const token = tokens[index];
    if (token === undefined || keys.has(index)) continue;
    const groupKey = token.subject === null ? token.listName : `${token.listName}@${token.subject}`;
    const n = countByName.get(groupKey) ?? 0;
    countByName.set(groupKey, n + 1);
    keys.set(index, occurrenceKeyOf(token.listName, token.subject, n));
  }
  return keys;
}

// Partial resolution for the picker's "Use prompt": substitute ONLY the pinned
// {{var::}} occurrences with their chosen option value (literal text), leaving
// unpinned {{var::}} tokens — and every other grammar token ({{random::}},
// {{roll::}}, {{ai-fill::}}, …) — verbatim so they re-roll on each Generate.
// Takes the RAW template body plus the opts the picker resolved with; pin keys
// are re-derived against the macro-resolved shape they were keyed to (see
// keysByRawToken). A pin whose option no longer exists — or whose occurrence
// lives in an un-picked {{random::}} branch — leaves a live token rather than
// dropping silently.
export function applyPinsToTemplateBody(
  body: string,
  lists: readonly VariableList[],
  opts: ResolveOpts,
): string {
  const pins = opts.pins;
  if (Object.keys(pins).length === 0) return body;

  const tokens = collectRawVarTokens(body);
  const keys = keysByRawToken(body, tokens, opts);

  let out = '';
  let cursor = 0;
  tokens.forEach((token, index) => {
    out += body.slice(cursor, token.start);
    cursor = token.end;
    const literal = body.slice(token.start, token.end);
    const key = keys.get(index);
    // Dual-form lookup mirrors AxisRow's currentPin: occurrence-key first, then
    // a bare list-name pin (legacy/provenance form) that applies to the list.
    const optionId = occurrencePin(pins, key, token.listName);
    if (optionId === undefined) {
      out += literal;
      return;
    }
    const list = findList(token.listName, lists);
    const option = list ? findOption(list, optionId) : undefined;
    out += option ? option.value : literal;
  });
  out += body.slice(cursor);

  return out;
}

function resolveRandomPick(text: string, rng: () => number): { text: string; changed: boolean } {
  const prefixes: readonly { prefix: string; sep: '::' | ',' }[] = [
    { prefix: '{{random::', sep: '::' },
    { prefix: '{{pick::', sep: '::' },
    { prefix: '{{random:', sep: ',' },
    { prefix: '{{pick:', sep: ',' },
  ];
  let out = '';
  let i = 0;
  let changed = false;

  while (i < text.length) {
    if (text.slice(i, i + 2) !== '{{') {
      const char = text[i];
      if (char !== undefined) out += char;
      i += 1;
      continue;
    }

    let matched = false;
    for (const { prefix, sep } of prefixes) {
      if (text.slice(i, i + prefix.length) !== prefix) continue;
      if (sep === ',' && text.slice(i + prefix.length, i + prefix.length + 1) === ':') continue;

      const close = findClose(text, i + prefix.length);
      if (close === -1) break;
      const payload = text.slice(i + prefix.length, close);
      const options = splitDepth0(payload, sep);
      out += choice(options, rng) ?? '';
      i = close + 2;
      changed = true;
      matched = true;
      break;
    }

    if (!matched) {
      const char = text[i];
      if (char !== undefined) out += char;
      i += 1;
    }
  }

  return { text: out, changed };
}

// Dice drawn across one whole resolve (pre and post macro passes together).
// Ordinary templates roll a handful; this keeps a huge count, or many macros,
// from pinning the render thread.
const MAX_DICE_PER_RESOLVE = 10_000;

interface MacroBudget {
  diceRemaining: number;
  readonly warnings: string[];
  readonly warned: Set<string>;
}

function createMacroBudget(warnings: string[] = []): MacroBudget {
  return { diceRemaining: MAX_DICE_PER_RESOLVE, warnings, warned: new Set() };
}

function warnOnce(budget: MacroBudget, message: string): void {
  if (budget.warned.has(message)) return;
  budget.warned.add(message);
  budget.warnings.push(message);
}

function rollDice(spec: string, rng: () => number, budget: MacroBudget): string {
  const literal = `{{roll::${spec}}}`;
  const trimmed = spec.trim();
  const dice = /^(?:(\d*)d)?(\d+)$/i.exec(trimmed);
  if (dice === null) return literal;

  const countRaw = dice[1];
  const sidesRaw = dice[2];
  if (sidesRaw === undefined) return literal;

  const count = Math.max(1, countRaw === undefined || countRaw === '' ? 1 : Number(countRaw));
  const sides = Math.max(1, Number(sidesRaw));
  const shown = trimmed.length > 24 ? `${trimmed.slice(0, 24)}...` : trimmed;
  // A safe product keeps every total exact and finite (no Infinity/NaN).
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(sides) || !Number.isSafeInteger(count * sides)) {
    warnOnce(budget, `dice roll too large, left unresolved: ${shown}`);
    return literal;
  }
  if (count > budget.diceRemaining) {
    warnOnce(budget, `dice limit of ${MAX_DICE_PER_RESOLVE} per prompt reached, left unresolved: ${shown}`);
    return literal;
  }
  budget.diceRemaining -= count;
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += 1 + Math.floor(rng() * sides);
  }
  return String(total);
}

function applyRegex(
  text: string,
  pattern: RegExp,
  handler: (match: readonly string[]) => string,
): { text: string; changed: boolean } {
  let changed = false;
  const next = text.replace(pattern, (...args: unknown[]) => {
    const groups = args.slice(0, -2);
    const match = groups.map((group) => String(group));
    changed = true;
    return handler(match);
  });
  return { text: next, changed };
}

// Strip {{//comment}} tokens with the same depth-aware walker var/random/pick
// use. A regex (`{{//[^}]*}}`) stops `[^}]*` at the FIRST `}`, so a comment whose
// body contains `}` (or a nested {{...}} token) never matches and leaks verbatim
// into the model prompt — findClose tracks brace depth and removes the whole span.
function resolveMacroPass(
  text: string,
  opts: ResolveOpts,
  rng: () => number,
  budget: MacroBudget,
): { text: string; changed: boolean } {
  let current = text;

  const stripped = stripTemplateComments(current);
  current = stripped.text;
  let changed = stripped.changed;

  const randomPick = resolveRandomPick(current, rng);
  current = randomPick.text;
  changed = changed || randomPick.changed;

  const transforms: [RegExp, (match: readonly string[]) => string][] = [
    [/\{\{roll::([^}]+)\}\}/gi, (match) => rollDice(match[1] ?? '', rng, budget)],
    [/\{\{roll:([^}]+)\}\}/gi, (match) => rollDice(match[1] ?? '', rng, budget)],
    [/\{\{user\}\}/g, () => opts.user ?? 'User'],
    [/\{\{newline\}\}/g, () => '\n'],
    [/\{\{(?:noop|trim)\}\}/g, () => ''],
  ];

  for (const [pattern, handler] of transforms) {
    const result = applyRegex(current, pattern, handler);
    current = result.text;
    changed = changed || result.changed;
  }

  return { text: current, changed };
}

function resolveMacros(text: string, opts: ResolveOpts, rng: () => number, budget: MacroBudget): string {
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = resolveMacroPass(current, opts, rng, budget);
    current = result.text;
    if (!result.changed) break;
  }
  return current;
}

export function resolve(
  template: PromptTemplate,
  lists: readonly VariableList[],
  dims: readonly TagDimension[],
  opts: ResolveOpts,
): ResolveResult {
  return resolveText(template.body, lists, dims, opts);
}

// Resolve a bare template body (no surrounding PromptTemplate). `resolve` above
// delegates here; the Composer's hand-typed-prompt path uses it directly, since
// free text has no template id/name/timestamps to wrap it in.
export function resolveText(
  body: string,
  lists: readonly VariableList[],
  dims: readonly TagDimension[],
  opts: ResolveOpts,
): ResolveResult {
  const warnings: string[] = [];
  const rng = mulberry32(opts.seed);
  // One dice budget spans both macro passes of this resolve.
  const macroBudget = createMacroBudget(warnings);
  // Pre-pass: resolve {{random::}} / {{pick::}} / {{roll::}} / {{user}} / {{newline}} /
  // {{noop}} / {{trim}} BEFORE collecting var occurrences. Lazy semantics — only
  // the var slots that survive macro resolution enter the SAT solver.
  const macroResolved = resolveMacros(body, opts, rng, macroBudget);
  const occurrences = collectVarOccurrences(macroResolved);
  const picksByKey = solveAxes(occurrences, lists, dims, opts, warnings, rng);
  const textWithVars = replaceVariables(macroResolved, lists, picksByKey, warnings);
  // Post-pass: rare case where a {{var::X}} option value itself contains a macro.
  const text = resolveMacros(textWithVars, opts, rng, macroBudget);
  const picks = assignmentToPins(picksByKey);
  return { text, picks, resolvedBody: macroResolved, seed: opts.seed, warnings };
}
