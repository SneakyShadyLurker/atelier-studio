import type {
  PromptLibraryResponse,
  PromptTemplate,
  TagDimension,
  VariableList,
  VariableOption,
} from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, isPromptLibraryResponse, requestJson, requestJsonValidated, requestNoContent } from './client';

export const promptKeys = {
  all: () => ['prompts'] as const,
  library: () => [...promptKeys.all(), 'library'] as const,
};

// `refetchOnMount: 'always'` was removed once the server started emitting an
// ETag for /api/prompts (api/src/routes/prompts/index.ts). With a 5 min
// `staleTime` and the ETag/304 path, default TanStack revalidation already
// keeps the library fresh on mount without paying the full payload cost.
export const promptLibraryOpts = () =>
  queryOptions({
    queryKey: promptKeys.library(),
    queryFn: fetchPromptLibrary,
    staleTime: 300_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 404 || !error.retryable)) return false;
      return failureCount < 2;
    },
  });

export interface CreateTemplateInput {
  readonly name: string;
  readonly body: string;
  readonly notes?: string;
}

export interface PatchTemplateInput {
  readonly name?: string;
  readonly body?: string;
  readonly notes?: string | null;
}

export interface ReplaceOptionInput {
  readonly id?: string;
  readonly value: string;
  readonly tagIds: readonly string[];
  readonly excludeTagIds?: readonly string[];
  readonly sortOrder: number;
  readonly weight?: number;
}

export interface UpdateOptionPatch {
  readonly value?: string;
  readonly tagIds?: readonly string[];
  readonly excludeTagIds?: readonly string[];
  readonly sortOrder?: number;
  readonly weight?: number;
}

export interface ReplaceTagInput {
  readonly id?: string;
  readonly label: string;
  readonly parentId?: string | null;
  readonly sortOrder: number;
}

export function fetchPromptLibrary(): Promise<PromptLibraryResponse> {
  return requestJsonValidated('/prompts', {}, isPromptLibraryResponse);
}

export function createTemplate(body: CreateTemplateInput): Promise<PromptTemplate> {
  return requestJson<PromptTemplate>('/prompts/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function patchTemplate(id: string, body: PatchTemplateInput): Promise<PromptTemplate> {
  return requestJson<PromptTemplate>(`/prompts/templates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteTemplate(id: string): Promise<void> {
  return requestNoContent(`/prompts/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function reorderTemplates(orderedIds: readonly string[]): Promise<PromptLibraryResponse> {
  return requestJsonValidated('/prompts/templates/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  }, isPromptLibraryResponse);
}

export function createList(name: string): Promise<VariableList> {
  return requestJson<VariableList>('/prompts/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function patchList(id: string, name: string): Promise<VariableList> {
  return requestJson<VariableList>(`/prompts/lists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteList(id: string): Promise<void> {
  return requestNoContent(`/prompts/lists/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function reorderLists(orderedIds: readonly string[]): Promise<PromptLibraryResponse> {
  return requestJsonValidated('/prompts/lists/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  }, isPromptLibraryResponse);
}

export function replaceOptions(listId: string, options: readonly ReplaceOptionInput[]): Promise<VariableList> {
  return requestJson<VariableList>(`/prompts/lists/${encodeURIComponent(listId)}/options`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ options }),
  });
}

export function updateOption(listId: string, optionId: string, patch: UpdateOptionPatch): Promise<void> {
  return requestNoContent(
    `/prompts/lists/${encodeURIComponent(listId)}/options/${encodeURIComponent(optionId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
}

export function createDimension(name: string): Promise<TagDimension> {
  return requestJson<TagDimension>('/prompts/dimensions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export interface PatchDimensionInput {
  readonly name?: string;
  readonly description?: string | null;
}

export function patchDimension(id: string, patch: PatchDimensionInput): Promise<TagDimension> {
  return requestJson<TagDimension>(`/prompts/dimensions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function deleteDimension(id: string): Promise<void> {
  return requestNoContent(`/prompts/dimensions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function replaceTags(dimId: string, tags: readonly ReplaceTagInput[]): Promise<TagDimension> {
  return requestJson<TagDimension>(`/prompts/dimensions/${encodeURIComponent(dimId)}/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
}

export function variableOptionFromInput(
  listId: string,
  option: ReplaceOptionInput,
  index: number,
): VariableOption {
  return {
    id: option.id ?? `optimistic:${listId}:${index}`,
    listId,
    value: option.value,
    tagIds: option.tagIds,
    ...(option.excludeTagIds === undefined ? {} : { excludeTagIds: option.excludeTagIds }),
    sortOrder: option.sortOrder,
    weight: option.weight ?? 1,
  };
}
