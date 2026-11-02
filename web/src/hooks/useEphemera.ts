import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { ephemeraStatusOpts } from '../api/ephemera';

/**
 * Whether the Ephemera character-card integration is on for this user. The
 * probe answers a leak-safe 404 when it is off (the usePromptLibrary shape);
 * any failure counts as off.
 */
export function useEphemera(): { enabled: boolean; origin: string | null; timeoutMs: number | null } {
  const q = useQuery(ephemeraStatusOpts());
  const gated = q.error instanceof ApiError && q.error.status === 404;
  const enabled = q.isSuccess && !gated;
  return enabled
    ? { enabled, origin: q.data.origin, timeoutMs: q.data.timeoutMs }
    : { enabled, origin: null, timeoutMs: null };
}
