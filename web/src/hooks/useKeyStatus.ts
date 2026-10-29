import type { ByokProvider } from '@atelier/shared';
import { useQuery } from '@tanstack/react-query';
import { byokStatusOpts } from '../api/keys';

export function useKeyStatus(provider: ByokProvider) {
  return useQuery(byokStatusOpts(provider));
}
