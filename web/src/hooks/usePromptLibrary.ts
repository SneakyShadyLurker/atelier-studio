import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { promptLibraryOpts } from '../api/prompts';

export function usePromptLibrary() {
  const q = useQuery(promptLibraryOpts());
  const gated = q.error instanceof ApiError && q.error.status === 404;
  return {
    enabled: q.isSuccess && !gated,
    gated,
    data: q.data,
    isLoading: q.isLoading,
    isError: q.isError && !gated,
    refetch: q.refetch,
  };
}
