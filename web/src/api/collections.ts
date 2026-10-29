import type { Collection, CollectionsResponse } from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, isCollectionsResponse, requestJson, requestJsonValidated, requestNoContent } from './client';

export const collectionKeys = {
  all: () => ['collections'] as const,
  list: () => [...collectionKeys.all(), 'list'] as const,
};

export const collectionListOpts = (enabled = true) =>
  queryOptions({
    queryKey: collectionKeys.list(),
    queryFn: fetchCollections,
    enabled,
    staleTime: 30_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && !error.retryable) return false;
      return failureCount < 2;
    },
  });

export function fetchCollections(): Promise<CollectionsResponse> {
  return requestJsonValidated('/collections', {}, isCollectionsResponse);
}

export function createCollection(name: string): Promise<Collection> {
  return requestJson<Collection>('/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function renameCollection(id: string, name: string): Promise<Collection> {
  return requestJson<Collection>(`/collections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteCollection(id: string): Promise<void> {
  return requestNoContent(`/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function reorderCollections(orderedIds: readonly string[]): Promise<CollectionsResponse> {
  return requestJson<CollectionsResponse>('/collections/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  });
}
