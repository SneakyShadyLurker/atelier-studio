import { useQuery } from '@tanstack/react-query';
import { collectionListOpts } from '../api/collections';

interface UseCollectionsOptions {
  enabled?: boolean;
}

export function useCollections(options: UseCollectionsOptions = {}) {
  return useQuery(collectionListOpts(options.enabled ?? true));
}
