import type { ByokKeyStatus, ByokProvider } from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, requestJson, requestNoContent } from './client';

const keyPath = (provider: ByokProvider) => `/keys/${provider}`;

export const byokKeys = {
  all: () => ['byok'] as const,
  status: (provider: ByokProvider) => [...byokKeys.all(), 'status', provider] as const,
};

export const byokStatusOpts = (provider: ByokProvider) =>
  queryOptions({
    queryKey: byokKeys.status(provider),
    queryFn: () => getKeyStatus(provider),
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 503) return false;
      if (error instanceof ApiError && !error.retryable) return false;
      return failureCount < 2;
    },
  });

function getKeyStatus(provider: ByokProvider): Promise<ByokKeyStatus> {
  return requestJson<ByokKeyStatus>(keyPath(provider));
}

export function putKey(provider: ByokProvider, key: string): Promise<ByokKeyStatus> {
  return requestJson<ByokKeyStatus>(keyPath(provider), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

export function deleteKey(provider: ByokProvider): Promise<void> {
  return requestNoContent(keyPath(provider), { method: 'DELETE' });
}


