import type { PromptLibraryResponse, PromptTemplate, TagDimension, VariableList } from '@atelier/shared';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { invalidatePromptLibrary } from './invalidateLibrary';
import {
  createDimension,
  createList,
  createTemplate,
  deleteDimension,
  deleteList,
  deleteTemplate,
  patchDimension,
  patchList,
  patchTemplate,
  promptKeys,
  reorderLists,
  reorderTemplates,
  replaceOptions,
  replaceTags,
  updateOption,
  variableOptionFromInput,
  type CreateTemplateInput,
  type PatchTemplateInput,
  type ReplaceOptionInput,
  type ReplaceTagInput,
  type UpdateOptionPatch,
} from '../api/prompts';

const PROMPT_LIBRARY_MUTATION_SCOPE = { id: 'prompt-library' };

// Editors are remounted when the operator navigates away and back, and a new
// instance has new mutation observers. These keys let it see a save its
// previous instance started that is still in the mutation cache.
const promptListMutationKey = ['prompt-library', 'list'] as const;
const patchListMutationKey = [...promptListMutationKey, 'name'] as const;
const replaceOptionsMutationKey = [...promptListMutationKey, 'options'] as const;
const updateOptionMutationKey = [...promptListMutationKey, 'option'] as const;
const replaceTagsMutationKey = ['prompt-library', 'dimension-tags'] as const;
const patchDimensionMutationKey = ['prompt-library', 'dimension-metadata'] as const;
const patchTemplateMutationKey = ['prompt-library', 'template'] as const;

/** True while any name, options or option save for this list is in flight. */
export function useListMutationPending(listId: string): boolean {
  const listIds = useMutationState<string | undefined>({
    filters: { mutationKey: promptListMutationKey, status: 'pending' },
    select: (mutation) => {
      const vars = mutation.state.variables as { readonly id?: string; readonly listId?: string } | undefined;
      return vars?.listId ?? vars?.id;
    },
  });
  return listIds.includes(listId);
}

/** True while a tag replacement for this dimension is in flight. */
export function useDimensionTagsPending(dimId: string): boolean {
  const dimIds = useMutationState<string | undefined>({
    filters: { mutationKey: replaceTagsMutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as ReplaceTagsVars | undefined)?.dimId,
  });
  return dimIds.includes(dimId);
}

/** True while a name or description save for this dimension is in flight. */
export function useDimensionMetadataPending(dimId: string): boolean {
  const dimIds = useMutationState<string | undefined>({
    filters: { mutationKey: patchDimensionMutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as PatchDimensionVars | undefined)?.id,
  });
  return dimIds.includes(dimId);
}

/** True while a save of this existing template is in flight. */
export function useTemplatePatchPending(templateId: string | null): boolean {
  const templateIds = useMutationState<string | undefined>({
    filters: { mutationKey: patchTemplateMutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as PatchTemplateVars | undefined)?.id,
  });
  return templateId !== null && templateIds.includes(templateId);
}

interface MutationContext {
  readonly prev: PromptLibraryResponse | undefined;
  readonly release: () => void;
}

interface PatchTemplateVars {
  readonly id: string;
  readonly body: PatchTemplateInput;
}

interface NameVars {
  readonly id: string;
  readonly name: string;
}

interface OrderVars {
  readonly orderedIds: readonly string[];
}

interface ReplaceOptionsVars {
  readonly listId: string;
  readonly options: readonly ReplaceOptionInput[];
}

interface UpdateOptionVars {
  readonly listId: string;
  readonly optionId: string;
  readonly patch: UpdateOptionPatch;
}

interface PatchDimensionVars {
  readonly id: string;
  readonly name?: string;
  readonly description?: string | null;
}

interface ReplaceTagsVars {
  readonly dimId: string;
  readonly tags: readonly ReplaceTagInput[];
}

// FIFO lock that serializes the prompt-library mutations' onMutate phase.
//
// Why this is NOT redundant with `scope: PROMPT_LIBRARY_MUTATION_SCOPE`:
// TanStack Query v5's scope serializes the RETRYER (the mutationFn) only —
// `Mutation.execute()` runs `onMutate` BEFORE `retryer.start()`, and the
// scope's `canRun` gate lives inside the retryer. So with scope alone, two
// rapidly-fired mutations both run their optimistic `onMutate`
// (snapshot + setQueryData) before either mutationFn executes. That is exactly
// the `useUpdateOption` snapshotHash-drift race (see its onMutate below): a
// second Save snapshotting the cache the first already optimistically mutated
// would compute a drifted snapshotHash and fall back to the destructive PUT.
// Each onMutate awaits this chain first, so the optimistic snapshots are
// strictly ordered. Verified against query-core mutation.ts; keep
// both the chain (serializes onMutate) and scope (serializes mutationFn).
let promptMutationChain: Promise<void> = Promise.resolve();

async function acquirePromptLibraryMutation(): Promise<() => void> {
  let releaseNext: () => void = () => undefined;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  const previous = promptMutationChain;
  promptMutationChain = previous.then(() => next, () => next);
  await previous.catch(() => undefined);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseNext();
  };
}

function sortByIds<T extends { readonly id: string }>(items: readonly T[], orderedIds: readonly string[]): readonly T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = orderedIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  return ordered.length === items.length ? ordered : items;
}

// Drops only the given tag ids from every option's required AND excluded
// memberships; all other constraints are left untouched.
function pruneOptionTagIds(lists: readonly VariableList[], removedIds: ReadonlySet<string>): readonly VariableList[] {
  if (removedIds.size === 0) return lists;
  return lists.map((list) => ({
    ...list,
    options: list.options.map((option) => ({
      ...option,
      tagIds: option.tagIds.filter((tagId) => !removedIds.has(tagId)),
      ...(option.excludeTagIds === undefined
        ? {}
        : { excludeTagIds: option.excludeTagIds.filter((tagId) => !removedIds.has(tagId)) }),
    })),
  }));
}

function patchTemplateCache(template: PromptTemplate, body: PatchTemplateInput): PromptTemplate {
  const next = {
    ...template,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.body !== undefined ? { body: body.body } : {}),
  };
  if (body.notes === undefined) return next;
  if (body.notes === null) {
    const { notes: _notes, ...withoutNotes } = next;
    return withoutNotes;
  }
  return { ...next, notes: body.notes };
}

interface LibraryMutationOptions<TData, TVars> {
  readonly mutationKey?: readonly unknown[];
  readonly mutationFn: (vars: TVars) => Promise<TData>;
  /** Optimistic cache transform; omitted for creates, which only invalidate. */
  readonly optimistic?: (library: PromptLibraryResponse, vars: TVars) => PromptLibraryResponse;
  /** Writes the server response into the cache before the settle invalidation. */
  readonly applySuccess?: (library: PromptLibraryResponse | undefined, data: TData) => PromptLibraryResponse | undefined;
}

/**
 * The one owner of the prompt-library mutation lifecycle: scope, FIFO lock,
 * cancel, snapshot, optimistic apply, rollback, release and invalidate. Every
 * library mutation goes through here so no hook can forget the lock release.
 */
function useLibraryMutation<TData, TVars>({
  mutationKey,
  mutationFn,
  optimistic,
  applySuccess,
}: LibraryMutationOptions<TData, TVars>) {
  const queryClient = useQueryClient();
  return useMutation<TData, Error, TVars, MutationContext>({
    ...(mutationKey ? { mutationKey } : {}),
    scope: PROMPT_LIBRARY_MUTATION_SCOPE,
    mutationFn,
    onMutate: async (vars) => {
      const release = await acquirePromptLibraryMutation();
      if (!optimistic) return { prev: undefined, release };
      try {
        await queryClient.cancelQueries({ queryKey: promptKeys.library() });
        const prev = queryClient.getQueryData<PromptLibraryResponse>(promptKeys.library());
        if (prev) queryClient.setQueryData<PromptLibraryResponse>(promptKeys.library(), optimistic(prev, vars));
        return { prev, release };
      } catch (error) {
        // TanStack hands onSettled an undefined context when onMutate throws,
        // so release here or every later library mutation deadlocks.
        release();
        throw error;
      }
    },
    ...(applySuccess
      ? {
          onSuccess: (data: TData) => {
            const next = applySuccess(queryClient.getQueryData<PromptLibraryResponse>(promptKeys.library()), data);
            if (next) queryClient.setQueryData<PromptLibraryResponse>(promptKeys.library(), next);
          },
        }
      : {}),
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(promptKeys.library(), ctx.prev);
    },
    onSettled: (_data, _error, _vars, ctx) => {
      ctx?.release();
      return invalidatePromptLibrary(queryClient);
    },
  });
}

export function useCreateTemplate() {
  return useLibraryMutation<PromptTemplate, CreateTemplateInput>({
    mutationFn: (body) => createTemplate(body),
  });
}

export function usePatchTemplate() {
  return useLibraryMutation<PromptTemplate, PatchTemplateVars>({
    mutationKey: patchTemplateMutationKey,
    mutationFn: ({ id, body }) => patchTemplate(id, body),
    optimistic: (library, { id, body }) => ({
      ...library,
      templates: library.templates.map((template) => (
        template.id === id ? patchTemplateCache(template, body) : template
      )),
    }),
  });
}

export function useDeleteTemplate() {
  return useLibraryMutation<undefined, string>({
    mutationFn: async (id) => {
      await deleteTemplate(id);
      return undefined;
    },
    optimistic: (library, id) => ({
      ...library,
      templates: library.templates.filter((template) => template.id !== id),
    }),
  });
}

export function useReorderTemplates() {
  return useLibraryMutation<PromptLibraryResponse, OrderVars>({
    mutationFn: ({ orderedIds }) => reorderTemplates(orderedIds),
    optimistic: (library, { orderedIds }) => ({
      ...library,
      templates: sortByIds(library.templates, orderedIds),
    }),
    applySuccess: (_library, response) => response,
  });
}

export function useCreateList() {
  return useLibraryMutation<VariableList, { readonly name: string }>({
    mutationFn: ({ name }) => createList(name),
  });
}

export function usePatchList() {
  return useLibraryMutation<VariableList, NameVars>({
    mutationKey: patchListMutationKey,
    mutationFn: ({ id, name }) => patchList(id, name),
    optimistic: (library, { id, name }) => ({
      ...library,
      variableLists: library.variableLists.map((list) => (list.id === id ? { ...list, name } : list)),
    }),
  });
}

export function useDeleteList() {
  return useLibraryMutation<undefined, string>({
    mutationFn: async (id) => {
      await deleteList(id);
      return undefined;
    },
    optimistic: (library, id) => ({
      ...library,
      variableLists: library.variableLists.filter((list) => list.id !== id),
    }),
  });
}

export function useReorderLists() {
  return useLibraryMutation<PromptLibraryResponse, OrderVars>({
    mutationFn: ({ orderedIds }) => reorderLists(orderedIds),
    optimistic: (library, { orderedIds }) => ({
      ...library,
      variableLists: sortByIds(library.variableLists, orderedIds),
    }),
    applySuccess: (_library, response) => response,
  });
}

export function useReplaceOptions() {
  return useLibraryMutation<VariableList, ReplaceOptionsVars>({
    mutationKey: replaceOptionsMutationKey,
    mutationFn: ({ listId, options }) => replaceOptions(listId, options),
    optimistic: (library, { listId, options }) => ({
      ...library,
      variableLists: library.variableLists.map((list) => (
        list.id === listId
          ? { ...list, options: options.map((option, index) => variableOptionFromInput(listId, option, index)) }
          : list
      )),
    }),
    applySuccess: (library, response) => library && {
      ...library,
      variableLists: library.variableLists.map((list) => (list.id === response.id ? response : list)),
    },
  });
}

export function useUpdateOption() {
  return useLibraryMutation<undefined, UpdateOptionVars>({
    mutationKey: updateOptionMutationKey,
    mutationFn: async ({ listId, optionId, patch }) => {
      await updateOption(listId, optionId, patch);
      return undefined;
    },
    // Optimistic cache update is load-bearing: ListEditor compares the parent
    // `list` prop against local drafts to decide whether Save is dirty. Without
    // updating the cached library immediately, the parent re-renders only
    // after onSettled invalidation + refetch, leaving a window where a Save
    // click routes the (unchanged-except-weight) options through the
    // destructive PUT /options endpoint -- which churns every option ID and
    // re-trips the snapshotHash drift guard the new PATCH path exists to
    // avoid.
    optimistic: (library, { listId, optionId, patch }) => ({
      ...library,
      variableLists: library.variableLists.map((list) =>
        list.id === listId
          ? {
              ...list,
              options: list.options.map((option) =>
                option.id === optionId
                  ? {
                      ...option,
                      ...(patch.value !== undefined ? { value: patch.value } : {}),
                      ...(patch.tagIds !== undefined ? { tagIds: patch.tagIds } : {}),
                      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
                      ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
                    }
                  : option,
              ),
            }
          : list,
      ),
    }),
  });
}

export function useCreateDimension() {
  return useLibraryMutation<TagDimension, { readonly name: string }>({
    mutationFn: ({ name }) => createDimension(name),
  });
}

export function usePatchDimension() {
  return useLibraryMutation<TagDimension, PatchDimensionVars>({
    mutationKey: patchDimensionMutationKey,
    mutationFn: ({ id, ...patch }) => patchDimension(id, patch),
    optimistic: (library, { id, name, description }) => ({
      ...library,
      dimensions: library.dimensions.map((dimension) => {
        if (dimension.id !== id) return dimension;
        // Only overwrite the fields the caller actually sent — a description-only
        // save must not blank the name, and vice versa.
        // exactOptionalPropertyTypes: a cleared description must drop the key
        // entirely rather than be set to undefined.
        const { description: prevDescription, ...rest } = dimension;
        const nextDescription = description === undefined ? prevDescription : (description ?? undefined);
        return {
          ...rest,
          ...(name !== undefined ? { name } : {}),
          ...(nextDescription !== undefined ? { description: nextDescription } : {}),
        };
      }),
    }),
  });
}

export function useDeleteDimension() {
  return useLibraryMutation<undefined, string>({
    mutationFn: async (id) => {
      await deleteDimension(id);
      return undefined;
    },
    optimistic: (library, id) => {
      const deletedTagIds = new Set(
        library.dimensions.find((dimension) => dimension.id === id)?.tags.map((tag) => tag.id) ?? [],
      );
      return {
        ...library,
        variableLists: pruneOptionTagIds(library.variableLists, deletedTagIds),
        dimensions: library.dimensions.filter((dimension) => dimension.id !== id),
      };
    },
  });
}

export function useReplaceTags() {
  return useLibraryMutation<TagDimension, ReplaceTagsVars>({
    mutationKey: replaceTagsMutationKey,
    mutationFn: ({ dimId, tags }) => replaceTags(dimId, tags),
    optimistic: (library, { dimId, tags }) => {
      const oldTagIds = new Set(
        library.dimensions.find((dimension) => dimension.id === dimId)?.tags.map((tag) => tag.id) ?? [],
      );
      // The server keeps supplied existing ids, so only the ids the caller
      // dropped lose their option memberships; renames, reorders and parent
      // moves keep every require/exclude constraint.
      const keptIds = new Set(tags.flatMap((tag) => (
        tag.id !== undefined && oldTagIds.has(tag.id) ? [tag.id] : []
      )));
      const removedIds = new Set([...oldTagIds].filter((tagId) => !keptIds.has(tagId)));
      return {
        ...library,
        variableLists: pruneOptionTagIds(library.variableLists, removedIds),
        dimensions: library.dimensions.map((dimension) => (
          dimension.id === dimId
            ? {
                ...dimension,
                tags: tags.map((tag, index) => ({
                  id: tag.id !== undefined && keptIds.has(tag.id) ? tag.id : `optimistic:${dimId}:${index}`,
                  dimensionId: dimId,
                  label: tag.label,
                  sortOrder: tag.sortOrder,
                  ...(tag.parentId === undefined ? {} : { parentId: tag.parentId }),
                })),
              }
            : dimension
        )),
      };
    },
    applySuccess: (library, response) => {
      if (!library) return undefined;
      // Server response is authoritative: prune any id it did not keep.
      const responseIds = new Set(response.tags.map((tag) => tag.id));
      const droppedIds = new Set(
        (library.dimensions.find((dimension) => dimension.id === response.id)?.tags ?? [])
          .map((tag) => tag.id)
          .filter((tagId) => !responseIds.has(tagId)),
      );
      return {
        ...library,
        variableLists: pruneOptionTagIds(library.variableLists, droppedIds),
        dimensions: library.dimensions.map((dimension) => (dimension.id === response.id ? response : dimension)),
      };
    },
  });
}
