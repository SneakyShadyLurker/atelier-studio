// CLI: deterministic prompt-library coherence audit.
//
// Usage (api STOPPED — see the sqlite-host-write-poisons-container-handle
// memory; readonly open mitigates but doesn't eliminate the contention risk
// against a live api):
//
//   ATELIER_DB_PATH=/path/to/atelier.sqlite ATELIER_USER_ID=<user-id> \
//     bun api/scripts/audit-prompt-library.ts
//
// Reads the live library via the same query helper the server uses,
// runs the same SAT engine, prints a summary, and exits non-zero on
// the first unsatisfiable template.

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { LibraryDiagnosisResponse, PromptLibraryResponse } from '@atelier/shared';
import { VAR_TOKEN_PATTERN, parseVarToken } from '@atelier/shared';
import { hasAiFillTokens, parseAiFillTokens } from '@atelier/shared/ai-fill';
import { diagnoseLibrary } from '../src/prompts/libraryDiagnosis';
import { promptLibrary } from '../src/routes/prompts/_shared';

const DB_PATH = process.env.ATELIER_DB_PATH ?? '/data/atelier.sqlite';

/** The library owner to audit; required, there is no default user. */
export function auditUserId(env: NodeJS.ProcessEnv): string | null {
  const userId = env.ATELIER_USER_ID?.trim();
  return userId === undefined || userId === '' ? null : userId;
}

export function computeExitCodeFromDiagnosis(diag: LibraryDiagnosisResponse): 0 | 1 {
  return diag.templates.some((t) => !t.satisfiable) ? 1 : 0;
}

// Exported for unit-testing without running the CLI entry point.
export function verifyUserExists(db: Database, userId: string): { ok: true } | { ok: false; reason: string } {
  const row = db.query('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | null;
  if (!row) {
    return { ok: false, reason: `User '${userId}' does not exist in the DB. Check ATELIER_USER_ID.` };
  }
  return { ok: true };
}

// Returns true if the path looks like a live production DB path.
export function isLikelyLiveDbPath(dbPath: string): boolean {
  return /\/data\/atelier\.sqlite$|atelier-data\/atelier\.sqlite$/.test(dbPath);
}

export function format(diag: LibraryDiagnosisResponse): string {
  const lines: string[] = [];
  const ok = diag.templates.filter((t) => t.satisfiable);
  const broken = diag.templates.filter((t) => !t.satisfiable);
  lines.push(`OK     (${ok.length}/${diag.templates.length})`);
  for (const t of ok) lines.push(`  - ${t.templateName}`);
  lines.push('');
  lines.push(`BROKEN (${broken.length}/${diag.templates.length})`);
  for (const t of broken) {
    lines.push(`  - ${t.templateName}${t.reason ? ` — ${t.reason}` : ''}`);
    for (const p of t.conflictingPairs ?? []) {
      lines.push(`      ${p.listA} ↔ ${p.listB} on ${p.dimensionName}`);
    }
  }
  return lines.join('\n');
}

// ─── Tag-hygiene invariants ─────────────────────────────────────────────
//
// The SAT check above proves each template has ≥1 valid combination, but it
// stays silent about tagging mistakes that make individual OPTIONS unreachable
// (the solver just never picks them) or that silently exclude an option from a
// whole genre.
//
// These checks are scoped to the SILOING dimensions — the axes where every option
// of a list is expected to share one value (Genre: a fantasy_* list is mono-genre
// Fantasy). Identity/spread dimensions (Fantasy Race, Franchise, Era, Daypart,
// Weather scope, Life-stage, …) legitimately give each option a distinct value, so
// "no shared value" is normal there and must NOT be flagged. Two pure checks catch
// the real defect class on the siloing axes:
//
//   • non-universal-in-full-list — every option carries a Genre tag, but no single
//     Genre value is on ALL options. The minority (lacking the dominant genre) can
//     never co-occur with a sibling list that is fully tagged only with that genre
//     → dead options / freeze on pin. (Caught `Cthulhu Mythos`/`The Vampire
//     Chronicles` missing Fantasy, and `Attack on Titan` missing Science Fiction.)
//   • sparse-tags — 1–3 options carry a Genre tag and the rest are untagged. Too
//     sparse to constrain, but silently bans those few from any template that
//     co-references a fully-Genre-tagged list. (Caught the lone Genre-tagged `face`
//     option banned from every fantasy/sci-fi render.)
//
// WARNINGS, not failures: a few are legitimate (a body-marker anachronism correctly
// scoped to Modern Earth). The audit surfaces them for a human to confirm; exit code
// stays driven by satisfiability.

// Dimensions where every option of a list is expected to share one value.
const SILOING_DIMENSIONS: ReadonlySet<string> = new Set(['Genre']);

export type TagHygieneWarning =
  | {
    readonly kind: 'non-universal-in-full-list' | 'sparse-tags' | 'same-tag-require-exclude';
    readonly listName: string;
    readonly dimensionName: string;
    readonly detail: string;
    readonly optionValues: readonly string[];
  }
  | {
    readonly kind: 'parent-cycle' | 'hierarchy-too-deep' | 'cross-dimension-parent';
    readonly dimensionName: string;
    readonly detail: string;
    readonly optionValues: readonly string[];
  };

const SPARSE_TAG_THRESHOLD = 3;

export interface ManualOnlyNote {
  readonly listName: string;
  readonly optionValues: readonly string[];
}

export function auditManualOnlyOptions(lib: PromptLibraryResponse): ManualOnlyNote[] {
  const notes: ManualOnlyNote[] = [];
  for (const list of lib.variableLists) {
    const optionValues = list.options
      .filter((option) => option.weight === 0)
      .map((option) => option.value);
    if (optionValues.length > 0) notes.push({ listName: list.name, optionValues });
  }
  return notes;
}

export function formatManualOnly(notes: readonly ManualOnlyNote[]): string {
  const count = notes.reduce((total, note) => total + note.optionValues.length, 0);
  if (count === 0) return 'MANUAL ONLY (0 options)';
  const lines = [`MANUAL ONLY (${count} ${count === 1 ? 'option' : 'options'})`];
  for (const note of notes) {
    lines.push(`  - ${note.listName}: excluded from automatic selection and automatic reachability checks`);
    for (const value of note.optionValues) lines.push(`      · ${value}`);
  }
  return lines.join('\n');
}

interface AuditTagMeta {
  readonly dimensionId: string;
  readonly dimensionName: string;
  readonly label: string;
  readonly parentId: string | null;
}

interface AuditTagIndex {
  readonly metaByTagId: ReadonlyMap<string, AuditTagMeta>;
  readonly expand: (tagIds: readonly string[]) => string[];
  readonly hierarchyWarnings: readonly TagHygieneWarning[];
}

function buildAuditTagIndex(lib: PromptLibraryResponse): AuditTagIndex {
  const metaByTagId = new Map<string, AuditTagMeta>();
  for (const dimension of lib.dimensions) {
    for (const tag of dimension.tags) {
      metaByTagId.set(tag.id, {
        dimensionId: dimension.id,
        dimensionName: dimension.name,
        label: tag.label,
        parentId: tag.parentId ?? null,
      });
    }
  }

  const hierarchyWarnings: TagHygieneWarning[] = [];
  const parentByTagId = new Map<string, string>();
  for (const [tagId, meta] of metaByTagId) {
    if (meta.parentId === null) continue;
    const parent = metaByTagId.get(meta.parentId);
    if (parent && parent.dimensionId !== meta.dimensionId) {
      hierarchyWarnings.push({
        kind: 'cross-dimension-parent',
        dimensionName: meta.dimensionName,
        detail: `'${meta.label}' points to parent '${parent.label}' in dimension '${parent.dimensionName}'`,
        optionValues: [meta.label],
      });
      continue;
    }
    if (parent) parentByTagId.set(tagId, meta.parentId);
  }

  const seenCycles = new Set<string>();
  const tooDeepTags = new Set<string>();
  for (const [tagId, meta] of metaByTagId) {
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = tagId;
    while (current !== undefined) {
      const cycleStart = position.get(current);
      if (cycleStart !== undefined) {
        const cycleIds = path.slice(cycleStart);
        const cycleKey = cycleIds.slice().sort().join('\u0000');
        if (!seenCycles.has(cycleKey)) {
          seenCycles.add(cycleKey);
          hierarchyWarnings.push({
            kind: 'parent-cycle',
            dimensionName: meta.dimensionName,
            detail: `cycle: ${cycleIds.map((id) => metaByTagId.get(id)?.label ?? id).join(' -> ')}`,
            optionValues: cycleIds.map((id) => metaByTagId.get(id)?.label ?? id),
          });
        }
        break;
      }
      position.set(current, path.length);
      path.push(current);
      if (path.length > 8 && !tooDeepTags.has(tagId)) {
        tooDeepTags.add(tagId);
        hierarchyWarnings.push({
          kind: 'hierarchy-too-deep',
          dimensionName: meta.dimensionName,
          detail: `'${meta.label}' has hierarchy depth ${path.length}; maximum is 8`,
          optionValues: [meta.label],
        });
      }
      current = parentByTagId.get(current);
    }
  }

  const closureByTagId = new Map<string, readonly string[]>();
  for (const tagId of metaByTagId.keys()) {
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
  return {
    metaByTagId,
    expand: (tagIds) => [...new Set(tagIds.flatMap((tagId) => closureByTagId.get(tagId) ?? [tagId]))],
    hierarchyWarnings,
  };
}

export function auditTagHygiene(lib: PromptLibraryResponse): TagHygieneWarning[] {
  const tagIndex = buildAuditTagIndex(lib);

  const warnings: TagHygieneWarning[] = [...tagIndex.hierarchyWarnings];
  for (const list of lib.variableLists) {
    const selectable = list.options.filter((option) => option.weight > 0);
    const total = selectable.length;

    // dimId → { dimName, set of tagged option ids, value → option values }
    const perDim = new Map<string, { dimName: string; tagged: Set<string>; byValue: Map<string, string[]> }>();
    for (const opt of list.options) {
      const required = new Set(tagIndex.expand(opt.tagIds));
      const excluded = new Set(tagIndex.expand(opt.excludeTagIds ?? []));
      for (const tagId of required) {
        if (!excluded.has(tagId)) continue;
        const meta = tagIndex.metaByTagId.get(tagId);
        if (!meta) continue;
        warnings.push({
          kind: 'same-tag-require-exclude',
          listName: list.name,
          dimensionName: meta.dimensionName,
          detail: `'${opt.value}' carries '${meta.label}' as both require and exclude`,
          optionValues: [opt.value],
        });
      }
      if (opt.weight === 0) continue;
      const labelsByDim = new Map<string, Set<string>>();
      for (const tagId of tagIndex.expand(opt.tagIds)) {
        const meta = tagIndex.metaByTagId.get(tagId);
        if (!meta || !SILOING_DIMENSIONS.has(meta.dimensionName)) continue;
        let labels = labelsByDim.get(meta.dimensionId);
        if (!labels) labelsByDim.set(meta.dimensionId, (labels = new Set()));
        labels.add(meta.label);
        if (!perDim.has(meta.dimensionId)) {
          perDim.set(meta.dimensionId, { dimName: meta.dimensionName, tagged: new Set(), byValue: new Map() });
        }
      }
      for (const [dimId, labels] of labelsByDim) {
        const pd = perDim.get(dimId);
        if (!pd) continue;
        pd.tagged.add(opt.id);
        for (const label of labels) {
          const arr = pd.byValue.get(label) ?? [];
          arr.push(opt.value);
          pd.byValue.set(label, arr);
        }
      }
    }

    if (total === 0) continue;

    for (const pd of perDim.values()) {
      const taggedCount = pd.tagged.size;

      if (taggedCount >= 1 && taggedCount <= SPARSE_TAG_THRESHOLD && taggedCount < total) {
        warnings.push({
          kind: 'sparse-tags',
          listName: list.name,
          dimensionName: pd.dimName,
          detail: `${taggedCount}/${total} options tagged — too sparse to constrain; complete the axis or drop the stray tag`,
          optionValues: [...new Set([...pd.byValue.values()].flat())],
        });
        continue;
      }

      if (taggedCount === total) {
        const hasUniversal = [...pd.byValue.values()].some((opts) => opts.length === total);
        if (hasUniversal) continue;
        let best: { label: string; opts: string[] } | null = null;
        for (const [label, opts] of pd.byValue) {
          if (!best || opts.length > best.opts.length) best = { label, opts };
        }
        if (!best) continue;
        const covered = new Set(best.opts);
        const minority = selectable.filter((o) => !covered.has(o.value)).map((o) => o.value);
        warnings.push({
          kind: 'non-universal-in-full-list',
          listName: list.name,
          dimensionName: pd.dimName,
          detail: `fully tagged, but no value covers all ${total} options ('${best.label}' covers ${best.opts.length}); the options below lack it — likely a missing tag (dead-option risk)`,
          optionValues: minority,
        });
      }
    }
  }
  return warnings;
}

// ─── Fill-boundary coherence gaps ───────────────────────────────────────
//
// The SAT engine treats a template body as ONE joint coherence context, but the
// runtime resolver does not: `buildAiFillRequest` resolves the masked static
// text and EACH {{ai-fill}} instruction in separate resolveComposerPrompt calls
// (seed, seed+1, …), so var picks never coherence-constrain each other across a
// fill boundary. A tagged-dimension pairing that straddles one is silently
// unenforced; a measured review found 85–92% out-of-universe race draws in
// genre templates before their race/marker/role slots were hoisted into
// static text.
//
// This check re-derives the runtime's context split per template and warns on
// every cross-context list pair that is NON-VACUOUSLY constrained on some
// dimension (i.e. at least one tagged×tagged option pair has disjoint labels —
// blanket same-label tagging constrains nothing and is not flagged).
//
// WARNINGS, not failures, mirroring tag hygiene: keep coherence-critical slots
// in one context (all static, or all inside the same instruction) to clear one.

export interface FillBoundaryWarning {
  readonly kind: 'fill-boundary';
  readonly templateName: string;
  readonly dimensionName: string;
  readonly listA: string;
  readonly contextA: string;
  readonly listB: string;
  readonly contextB: string;
}

interface VarOccurrence {
  readonly listName: string;
  readonly subject: number | null;
}

// The pattern's own optional @N group only matches an unpadded suffix, so the
// captured inner text is re-parsed through the canonical parseVarToken — a
// padded "{{var:: race @1 }}" is a valid runtime token (list "race", subject 1)
// and must not be recorded as a nonexistent list named "race @1".
function varOccurrencesIn(text: string): readonly VarOccurrence[] {
  const seen = new Map<string, VarOccurrence>();
  const re = new RegExp(VAR_TOKEN_PATTERN, 'g');
  for (const m of text.matchAll(re)) {
    const inner = `${m[1] ?? ''}${m[2] !== undefined ? `@${m[2]}` : ''}`;
    const { listName, subject } = parseVarToken(inner);
    if (!listName) continue;
    seen.set(`${listName}§${subject ?? ''}`, { listName, subject });
  }
  return [...seen.values()];
}

// Mirrors the resolver's subject-scoped coherence: two occurrences are only
// pairwise-constrained when their subjects are compatible (same group, or
// either is scene-level/null). @1 × @2 is unconstrained by construction — a
// cross-context @1/@2 pair loses nothing and must not be flagged.
const subjectsCompatible = (a: VarOccurrence, b: VarOccurrence): boolean =>
  a.subject === null || b.subject === null || a.subject === b.subject;

export function auditFillBoundaries(lib: PromptLibraryResponse): FillBoundaryWarning[] {
  const tagIndex = buildAuditTagIndex(lib);

  interface OptionPolaritySets {
    readonly require: ReadonlySet<string>;
    readonly exclude: ReadonlySet<string>;
  }
  // list name → dimension id → polarity sets of its constrained options
  const taggedByList = new Map<string, Map<string, OptionPolaritySets[]>>();
  for (const list of lib.variableLists) {
    const perDim = new Map<string, OptionPolaritySets[]>();
    for (const opt of list.options.filter((option) => option.weight > 0)) {
      const requiredByDim = new Map<string, Set<string>>();
      const excludedByDim = new Map<string, Set<string>>();
      for (const [tagIds, target] of [
        [tagIndex.expand(opt.tagIds), requiredByDim],
        [tagIndex.expand(opt.excludeTagIds ?? []), excludedByDim],
      ] as const) {
        for (const tagId of tagIds) {
          const meta = tagIndex.metaByTagId.get(tagId);
          if (!meta) continue;
          let tags = target.get(meta.dimensionId);
          if (!tags) target.set(meta.dimensionId, (tags = new Set()));
          tags.add(tagId);
        }
      }
      for (const dimensionId of new Set([...requiredByDim.keys(), ...excludedByDim.keys()])) {
        const arr = perDim.get(dimensionId) ?? [];
        arr.push({
          require: requiredByDim.get(dimensionId) ?? new Set(),
          exclude: excludedByDim.get(dimensionId) ?? new Set(),
        });
        perDim.set(dimensionId, arr);
      }
    }
    taggedByList.set(list.name, perDim);
  }

  const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
    for (const x of a) if (b.has(x)) return true;
    return false;
  };

  const conflicts = (a: OptionPolaritySets, b: OptionPolaritySets): boolean => (
    intersects(a.exclude, b.require)
    || intersects(b.exclude, a.require)
    || (a.require.size > 0 && b.require.size > 0 && !intersects(a.require, b.require))
  );

  // Non-vacuous iff some option pair conflicts under the runtime predicate.
  const nonVacuous = (a: OptionPolaritySets[], b: OptionPolaritySets[]): boolean =>
    a.some((sa) => b.some((sb) => conflicts(sa, sb)));

  const warnings: FillBoundaryWarning[] = [];
  for (const tpl of lib.templates) {
    if (!hasAiFillTokens(tpl.body)) continue;
    const { slots, staticSegments } = parseAiFillTokens(tpl.body);
    if (slots.length === 0) continue;

    const contexts: { label: string; occurrences: readonly VarOccurrence[] }[] = [
      { label: 'static', occurrences: varOccurrencesIn(staticSegments.join('\n')) },
      ...slots.map((slot, i) => ({ label: `fill #${i + 1}`, occurrences: varOccurrencesIn(slot.instruction) })),
    ];

    const seen = new Set<string>();
    for (const [i, ci] of contexts.entries()) {
      for (const cj of contexts.slice(i + 1)) {
        for (const a of ci.occurrences) {
          for (const b of cj.occurrences) {
            if (!subjectsCompatible(a, b)) continue;
            const dimsA = taggedByList.get(a.listName);
            const dimsB = taggedByList.get(b.listName);
            if (!dimsA || !dimsB) continue;
            for (const [dimensionId, setsA] of dimsA) {
              const setsB = dimsB.get(dimensionId);
              if (!setsB || !nonVacuous(setsA, setsB)) continue;
              const dimensionName = [...tagIndex.metaByTagId.values()]
                .find((meta) => meta.dimensionId === dimensionId)?.dimensionName;
              if (!dimensionName) continue;
              const key = [tpl.name, dimensionId, ...[a.listName, b.listName].sort()].join('§');
              if (seen.has(key)) continue;
              seen.add(key);
              warnings.push({
                kind: 'fill-boundary', templateName: tpl.name, dimensionName,
                listA: a.listName, contextA: ci.label, listB: b.listName, contextB: cj.label,
              });
            }
          }
        }
      }
    }
  }
  return warnings;
}

export function formatFillBoundaries(warnings: readonly FillBoundaryWarning[]): string {
  if (warnings.length === 0) return 'FILL BOUNDARIES (0 warnings)';
  const lines = [`FILL BOUNDARIES (${warnings.length} warnings)`];
  for (const w of warnings) {
    lines.push(`  - [fill-boundary] ${w.templateName}: ${w.listA} (${w.contextA}) × ${w.listB} (${w.contextB}) on ${w.dimensionName} — runtime resolves these in separate contexts; the constraint is not enforced`);
  }
  return lines.join('\n');
}

export function formatHygiene(warnings: readonly TagHygieneWarning[]): string {
  if (warnings.length === 0) return 'TAG HYGIENE (0 warnings)';
  const lines = [`TAG HYGIENE (${warnings.length} warnings)`];
  for (const w of warnings) {
    const scope = 'listName' in w ? `${w.listName} on ${w.dimensionName}` : w.dimensionName;
    lines.push(`  - [${w.kind}] ${scope}: ${w.detail}`);
    for (const v of w.optionValues) lines.push(`      · ${v}`);
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const USER_ID = auditUserId(process.env);
  if (USER_ID === null) {
    console.error('ATELIER_USER_ID is required: set it to the id of the library owner to audit.');
    process.exit(3);
  }
  if (!existsSync(DB_PATH)) {
    console.error(`ATELIER_DB_PATH does not exist: ${DB_PATH}`);
    process.exit(2);
  }

  // Live-DB guard: refuse to run against a production path unless the operator
  // has explicitly set ATELIER_ALLOW_LIVE_DB_AUDIT=1. Distinct exit code (4)
  // lets CI distinguish this refusal from a broken library (1) or missing user (3).
  const liveOverride = process.env.ATELIER_ALLOW_LIVE_DB_AUDIT === '1';
  if (isLikelyLiveDbPath(DB_PATH) && !liveOverride) {
    console.error(`Refusing to audit '${DB_PATH}' — looks like a live production DB.`);
    console.error(`Stop the api first, or set ATELIER_ALLOW_LIVE_DB_AUDIT=1 to override.`);
    process.exit(4);
  }

  const db = new Database(DB_PATH, { readonly: true });
  try {
    // User-existence check before running diagnosis — a missing user produces a
    // misleading empty library rather than a clear error. Exit code 3 lets CI
    // distinguish "user missing" from "library broken" (1) or "path missing" (2).
    const userCheck = verifyUserExists(db, USER_ID);
    if (!userCheck.ok) {
      console.error(userCheck.reason);
      console.error(`Audit aborted — exit code 3 means "user not found".`);
      process.exit(3);
    }

    const lib = promptLibrary(db, USER_ID);
    const diag = diagnoseLibrary(lib);
    console.log(format(diag));
    console.log('');
    console.log(formatHygiene(auditTagHygiene(lib)));
    console.log('');
    console.log(formatManualOnly(auditManualOnlyOptions(lib)));
    console.log('');
    console.log(formatFillBoundaries(auditFillBoundaries(lib)));
    process.exit(computeExitCodeFromDiagnosis(diag));
  } finally {
    db.close();
  }
}
