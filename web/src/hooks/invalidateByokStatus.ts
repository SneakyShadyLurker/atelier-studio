import type { QueryClient } from '@tanstack/react-query';
import type { ByokProvider } from '@atelier/shared';
import { byokKeys } from '../api/keys';
import { modelKeys } from '../api/models';

// A BYOK key change flips both the provider's key status and which models are
// available, so both queries must be revalidated together. Shared by useSetKey
// and useDeleteKey. Fire-and-forget (matches the original onSuccess bodies).
export function invalidateByokStatus(queryClient: QueryClient, provider: ByokProvider): void {
  void queryClient.invalidateQueries({ queryKey: byokKeys.status(provider) });
  void queryClient.invalidateQueries({ queryKey: modelKeys.list() });
}
