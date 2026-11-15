import { useTextModels } from './useTextModels';
import { useTextProviders } from './useTextProviders';

/**
 * Who the Text models view is for. The admin probe (`GET /api/text-providers`)
 * answers 404 for everyone outside TEXT_PROVIDER_ADMINS ('no'). Any answer
 * with providers makes an admin ('yes'), and a failed background refetch keeps
 * that answer. A failure with no answer yet is 'error'; no answer and no
 * failure yet is 'pending'.
 */
export type TextAdminState = 'pending' | 'yes' | 'no' | 'error';

export function useTextAdminState(): TextAdminState {
  const probe = useTextProviders();
  if (probe.gated) return 'no';
  if (probe.data !== undefined) return 'yes';
  if (probe.isError) return 'error';
  return 'pending';
}

/**
 * Whether the sidebar lists Text models: always for a text admin; for anyone
 * else once the latest successful `GET /api/text-models` lists a model
 * (TanStack keeps that answer through a failed refetch). Hidden for a
 * non-admin while that read is pending or has never succeeded.
 */
export function useTextModelsEntry(): boolean {
  const admin = useTextAdminState();
  const models = useTextModels();
  if (admin === 'yes') return true;
  // Read as unknown: a body without a models array is no proof of a model.
  const list: unknown = models.data?.models;
  return Array.isArray(list) && list.length > 0;
}
