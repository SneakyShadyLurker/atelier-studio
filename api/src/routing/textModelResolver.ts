import type { TextReasoningEffort, TextTask } from '@atelier/shared';
import type { TextModelRecord, TextProviderRecord, TextProviderStore } from '../db/textProviders';
import type { TextAvailabilityHandle } from '../lifecycle/text-availability';
import type { TextConfigSnapshot } from './textConfigSnapshot';

// Which configured text model serves a call (spec § 7). Precedence, first
// eligible wins: locked prompt writer, request pin, user pick, preferred
// prompt writer, task assignment, default model. A locked writer never falls
// through; every other step skips an ineligible candidate. Config comes from
// the in-memory snapshot, availability live from the poller; the only DB read
// is the user's picks.

export interface TextModelResolverDeps {
  readonly snapshot: TextConfigSnapshot;
  readonly availability: Pick<TextAvailabilityHandle, 'statusOf'>;
  readonly store: Pick<TextProviderStore, 'readUserPicks'>;
}

export interface ResolveTextModelInput {
  readonly userId: string;
  readonly task: TextTask;
  /** Image model the text is written for; selects a prompt writer. */
  readonly imageModelId?: string;
  /** The call carries images: only vision models qualify. */
  readonly visionRequired?: boolean;
  /** Explicit model row id from the request (brainstorm `textModelId`). */
  readonly requestPin?: string;
  /** Model row ids to skip (brainstorm failover); never crosses a locked writer. */
  readonly excludeModelIds?: readonly string[];
}

export type TextModelSource = 'request' | 'writer' | 'user' | 'task' | 'default';

export type TextResolveFailure = 'not-configured' | 'no-vision-model' | 'pin-unavailable';

/**
 * State of the user's own pick for the task, absent when there is none:
 * 'offline' = it was skipped as ineligible (Settings shows "offline, using the default").
 */
export type TextPickState = 'active' | 'offline';

export type ResolvedTextModel =
  | {
      readonly ok: true;
      readonly model: TextModelRecord;
      readonly provider: TextProviderRecord;
      /** The user's effort; absent means the model's `reasoningDefault` applies. */
      readonly effort?: TextReasoningEffort;
      readonly source: TextModelSource;
      readonly pickState?: TextPickState;
    }
  | { readonly ok: false; readonly reason: TextResolveFailure; readonly pickState?: TextPickState };

type Eligibility = 'eligible' | 'vision-only' | 'ineligible';

export function resolveTextModel(deps: TextModelResolverDeps, input: ResolveTextModelInput): ResolvedTextModel {
  const config = deps.snapshot.current();
  const excluded = new Set(input.excludeModelIds ?? []);

  // `ignoreOffline` is for the locked writer: "always use this model" means a
  // listing gap must not reroute or block it; the call itself reports a real outage.
  const check = (modelId: string | undefined, ignoreOffline = false): Eligibility => {
    if (modelId === undefined || excluded.has(modelId)) return 'ineligible';
    // The snapshot holds only enabled models of enabled providers.
    const model = config.models.get(modelId);
    if (!model || (!ignoreOffline && deps.availability.statusOf(model) === 'offline')) return 'ineligible';
    return input.visionRequired === true && !model.vision ? 'vision-only' : 'eligible';
  };

  const pick = deps.store.readUserPicks(input.userId)[input.task];
  const pickState: TextPickState | undefined = pick ? (check(pick.modelId) === 'eligible' ? 'active' : 'offline') : undefined;
  const withPick = pickState ? { pickState } : {};

  const serve = (modelId: string, source: TextModelSource): ResolvedTextModel => {
    const model = config.models.get(modelId);
    const provider = model && config.providers.get(model.providerId);
    // check() admitted the model, so both are present.
    if (!model || !provider) return { ok: false, reason: 'not-configured', ...withPick };
    const effort = pick?.modelId === modelId && pick.effort !== null && model.reasoningLevels.includes(pick.effort)
      ? pick.effort
      : undefined;
    return { ok: true, model, provider, source, ...(effort ? { effort } : {}), ...withPick };
  };

  const writer = input.imageModelId === undefined ? undefined : config.writers[input.imageModelId];
  if (writer?.mode === 'lock') {
    return check(writer.modelId, true) === 'eligible'
      ? serve(writer.modelId, 'writer')
      : { ok: false, reason: 'pin-unavailable', ...withPick };
  }

  const candidates: readonly (readonly [string | undefined, TextModelSource])[] = [
    [input.requestPin, 'request'],
    [pick?.modelId, 'user'],
    [writer?.modelId, 'writer'],
    [config.defaults.byTask[input.task], 'task'],
    [config.defaults.default, 'default'],
  ];
  let visionBlocked = false;
  for (const [modelId, source] of candidates) {
    const eligibility = check(modelId);
    if (modelId !== undefined && eligibility === 'eligible') return serve(modelId, source);
    if (eligibility === 'vision-only') visionBlocked = true;
  }
  return { ok: false, reason: visionBlocked ? 'no-vision-model' : 'not-configured', ...withPick };
}
