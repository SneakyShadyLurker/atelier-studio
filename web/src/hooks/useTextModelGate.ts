import { useTextModels } from './useTextModels';
import { useTextProviders } from './useTextProviders';

export interface TextModelGate {
  /** 'none' only when `/text-models` answered with zero models. */
  readonly availability: 'none' | 'available' | 'unknown';
  /** 'unknown' while the admin probe loads or fails with a non-404 error. */
  readonly admin: 'yes' | 'no' | 'unknown';
}

/**
 * Whether an AI action can reach a text model at all, and who can fix it when
 * it cannot. It blocks nothing itself: the triggers open `TextModelNote` only
 * on a conclusive 'none'. Per-task `effectiveModelId` is deliberately not
 * read: the server also routes by image-model writers, vision and request
 * pins, so its 409 toast stays the answer for every other outcome.
 */
export function useTextModelGate(): TextModelGate {
  const models = useTextModels();
  const providers = useTextProviders();
  // Read as unknown: a body without a models array (a proxy page, a stub) is
  // no proof of absence, and the gate must never take an action down with it.
  const list: unknown = models.data?.models;
  const availability = !Array.isArray(list) ? 'unknown' : list.length === 0 ? 'none' : 'available';
  const admin = providers.enabled ? 'yes' : providers.gated ? 'no' : 'unknown';
  return { availability, admin };
}
