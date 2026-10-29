import type { PromptTemplate, TagDimension, VariableList } from '@atelier/shared';
import type { QueuedRoll } from '../store/atelier';
import { collectVarOccurrences, resolve, selectableOptions } from './promptResolver';

export interface SweepRollsResult {
  readonly rolls: readonly QueuedRoll[];
  readonly labels: readonly string[];
  readonly count: number;
}

/**
 * Build one QueuedRoll per selectable option of the swept axis,
 * isolating the swept axis as the only variable.
 *
 * `sweepKey` is an opaque occurrence key from collectVarOccurrences — never
 * parse it. Algorithm: resolve ONCE at `baseSeed` to freeze the full
 * assignment, drop the sweep key to get `frozenBase` (every NON-swept axis
 * pinned to its frozen pick — including axes the user left random), then for
 * each positive-weight option admissible against `frozenBase`, resolve with the SAME
 * `baseSeed` and the swept axis pinned to that option. Same seed + all other
 * axes pinned ⇒ only the swept value differs roll-to-roll. Each roll carries
 * `provenance` (Feature ②) so the fired batch is reproducible.
 */
export function buildSweepRolls(
  template: PromptTemplate,
  lists: readonly VariableList[],
  dims: readonly TagDimension[],
  basePins: Readonly<Record<string, string>>,
  sweepKey: string,
  baseSeed: number,
): SweepRollsResult {
  // Freeze the full assignment at baseSeed AND capture the macro-resolved body
  // — the exact shape resolve() ran collectVarOccurrences against to produce
  // `picks`. Occurrence keys MUST be derived from this resolved body, not the
  // raw template.body: an unpicked {{random::}} branch carrying a {{var::X}}
  // token shifts later same-list indices, so a raw-body key (face#1) never
  // re-resolves against the resolved picks (face#0) and the per-option pin is
  // silently dropped, firing identical rolls (Finding A).
  const base = resolve(template, lists, dims, { seed: baseSeed, pins: { ...basePins } });
  const occurrences = collectVarOccurrences(base.resolvedBody);
  const sweepOcc = occurrences.find((o) => o.key === sweepKey);
  if (sweepOcc === undefined) return { rolls: [], labels: [], count: 0 };

  const frozen = base.picks;
  const frozenBase: Record<string, string> = {};
  for (const [key, value] of Object.entries(frozen)) {
    if (key !== sweepKey) frozenBase[key] = value;
  }

  // Selectability is evaluated against the frozen full assignment — the count
  // reflects true coherence against every non-swept axis, not just user pins,
  // and excludes manual-only options.
  const options = selectableOptions(sweepOcc, occurrences, frozenBase, lists, dims);
  const rolls: QueuedRoll[] = [];
  const labels: string[] = [];

  for (const option of options) {
    const pins = { ...frozenBase, [sweepKey]: option.id };
    const result = resolve(template, lists, dims, { seed: baseSeed, pins });
    rolls.push({
      id: crypto.randomUUID(),
      text: result.text,
      seed: baseSeed,
      source: 'sweep',
      provenance: { templateId: template.id, rollSeed: baseSeed, pins },
    });
    labels.push(option.value);
  }

  return { rolls, labels, count: rolls.length };
}
