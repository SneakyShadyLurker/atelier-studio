import type { QueryClient } from '@tanstack/react-query';
import { archiveKeys } from '../api/archive';
import { collectionKeys } from '../api/collections';
import { historyKeys } from '../api/history';
import { libraryCoverageKeys } from '../api/libraryCoverage';
import { libraryDiagnosisKeys } from '../api/libraryDiagnosis';
import { promptKeys } from '../api/prompts';

interface InvalidateLibraryOptions {
  historyRefetchType?: 'active' | 'all' | 'inactive' | 'none';
}

export function invalidateLibrary(
  queryClient: QueryClient,
  options: InvalidateLibraryOptions = {},
): Promise<unknown[]> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: historyKeys.all(),
      ...(options.historyRefetchType ? { refetchType: options.historyRefetchType } : {}),
    }),
    queryClient.invalidateQueries({ queryKey: archiveKeys.all() }),
    queryClient.invalidateQueries({ queryKey: collectionKeys.list() }),
  ]);
}

export function invalidatePromptLibrary(queryClient: QueryClient): Promise<unknown[]> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: promptKeys.all() }),
    queryClient.invalidateQueries({ queryKey: libraryDiagnosisKeys.all() }),
    queryClient.invalidateQueries({ queryKey: libraryCoverageKeys.current() }),
  ]);
}
