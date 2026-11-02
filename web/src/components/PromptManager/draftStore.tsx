import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { registerUnsavedWork } from '../../lib/preloadRecovery';

export interface TemplateDraft {
  readonly name: string;
  readonly body: string;
}

export interface OptionDraft {
  readonly key: string;
  readonly value: string;
  readonly tagIds: readonly string[];
  readonly excludeTagIds: readonly string[];
  readonly weight: number;
  readonly weightInput: string;
  readonly expanded: boolean;
}

export interface ListDraft {
  readonly name: string;
  readonly options: readonly OptionDraft[];
}

export interface TagDraft {
  readonly id?: string;
  readonly key: string;
  readonly label: string;
  readonly parentId: string | null;
}

export interface DimensionDraft {
  readonly name: string;
  readonly description: string;
  // The server value each field was last taken from; null while a save of that
  // field is in flight. A field still equal to its base is clean.
  readonly nameBase: string | null;
  readonly descriptionBase: string | null;
  readonly tags: readonly TagDraft[];
}

export interface DimensionBases {
  readonly nameBase?: string;
  readonly descriptionBase?: string;
}

// Fills only the bases a save left pending; a base that is already known stays.
export function settleDimensionBases(draft: DimensionDraft, bases: DimensionBases): DimensionDraft {
  return {
    ...draft,
    nameBase: draft.nameBase ?? bases.nameBase ?? null,
    descriptionBase: draft.descriptionBase ?? bases.descriptionBase ?? null,
  };
}

// Adopts server ids for the saved rows by their stable local keys, whatever was
// added, removed or reordered meanwhile, and drops ids and parent links the
// server no longer holds so the next save neither re-inserts nor 400s.
export function reconcileTagIds(
  tags: readonly TagDraft[],
  savedIdByKey: ReadonlyMap<string, string>,
  persistedIds: ReadonlySet<string>,
): readonly TagDraft[] {
  return tags.map((tag) => {
    const id = savedIdByKey.get(tag.key) ?? tag.id;
    const parentId = tag.parentId !== null && persistedIds.has(tag.parentId) ? tag.parentId : null;
    return id !== undefined && persistedIds.has(id)
      ? { id, key: tag.key, label: tag.label, parentId }
      : { key: tag.key, label: tag.label, parentId };
  });
}

export type DimensionSettlement =
  | { readonly kind: 'bases'; readonly bases: DimensionBases }
  | {
      readonly kind: 'tags';
      // Rows exactly as submitted, and the server's rows as drafts: a draft
      // nobody touched during the save is replaced wholesale, as before.
      readonly submitted: readonly TagDraft[];
      readonly saved: readonly TagDraft[];
      readonly savedIdByKey: ReadonlyMap<string, string>;
      readonly persistedIds: ReadonlySet<string>;
    };

export function settleTagDrafts(
  tags: readonly TagDraft[],
  settlement: Extract<DimensionSettlement, { kind: 'tags' }>,
): readonly TagDraft[] {
  return sameDraft(tags, settlement.submitted)
    ? settlement.saved
    : reconcileTagIds(tags, settlement.savedIdByKey, settlement.persistedIds);
}

export function applyDimensionSettlement(draft: DimensionDraft, settlement: DimensionSettlement): DimensionDraft {
  return settlement.kind === 'bases'
    ? settleDimensionBases(draft, settlement.bases)
    : { ...draft, tags: settleTagDrafts(draft.tags, settlement) };
}

// Renames saved rows to their server ids by key only, so every other field,
// and any row added, removed or reordered meanwhile, stays as edited.
export function remapOptionKeys(
  options: readonly OptionDraft[],
  keys: ReadonlyMap<string, string>,
): readonly OptionDraft[] {
  if (keys.size === 0) return options;
  return options.map((option) => {
    const key = keys.get(option.key);
    return key === undefined ? option : { ...option, key };
  });
}

export interface PromptSelection {
  readonly templateId: string | null;
  readonly listId: string | null;
  readonly dimensionId: string | null;
  readonly newTemplateName: string | null;
}

function sameDraft<T>(a: T | undefined, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** In-memory drafts scoped to one mounted App/session. Never persisted. */
export class PromptDraftStore {
  private readonly templates = new Map<string, TemplateDraft>();
  private readonly lists = new Map<string, ListDraft>();
  private readonly dimensions = new Map<string, DimensionDraft>();
  private readonly dimensionEditors = new Map<string, (settlement: DimensionSettlement) => void>();
  private readonly listEditors = new Map<string, (keys: ReadonlyMap<string, string>) => void>();
  private selection: PromptSelection = { templateId: null, listId: null, dimensionId: null, newTemplateName: null };
  private readonly listeners = new Set<() => void>();
  private templateCreatePending = false;
  private listPruneRevision = 0;

  private notify(): void { for (const listener of this.listeners) listener(); }

  getSelection = (): PromptSelection => this.selection;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  setSelection(next: PromptSelection): void {
    const current = this.selection;
    if (current.templateId === next.templateId && current.listId === next.listId
      && current.dimensionId === next.dimensionId && current.newTemplateName === next.newTemplateName) return;
    this.selection = { ...next };
    this.notify();
  }
  adoptCreatedTemplate(id: string): boolean {
    if (this.selection.newTemplateName === null || this.selection.templateId !== null) return false;
    this.setSelection({ ...this.selection, templateId: id, newTemplateName: null });
    return true;
  }
  getTemplateCreatePending = (): boolean => this.templateCreatePending;
  beginTemplateCreate(): boolean {
    if (this.templateCreatePending) return false;
    this.templateCreatePending = true;
    this.notify();
    return true;
  }
  endTemplateCreate(): void {
    if (!this.templateCreatePending) return;
    this.templateCreatePending = false;
    this.notify();
  }
  getListPruneRevision = (): number => this.listPruneRevision;
  // Editors keep their entries in step with their dirty state, and an entry
  // outlives its editor, so this covers drafts retained off-view as well.
  hasDrafts = (): boolean => this.templates.size > 0
    || this.lists.size > 0
    || this.dimensions.size > 0
    || this.selection.newTemplateName !== null;

  getTemplate(id: string): TemplateDraft | undefined { return this.templates.get(id); }
  setTemplate(id: string, draft: TemplateDraft): void { this.templates.set(id, draft); }
  deleteTemplate(id: string): void { this.templates.delete(id); }
  clearTemplateIfUnchanged(id: string, submitted: TemplateDraft): void {
    if (sameDraft(this.templates.get(id), submitted)) this.deleteTemplate(id);
  }
  moveTemplate(from: string, to: string): void {
    const draft = this.templates.get(from);
    if (draft) this.templates.set(to, draft);
    this.deleteTemplate(from);
  }

  getList(id: string): ListDraft | undefined { return this.lists.get(id); }
  setList(id: string, draft: ListDraft): void { this.lists.set(id, draft); }
  deleteList(id: string): void { this.lists.delete(id); }
  clearListIfUnchanged(id: string, submitted: ListDraft): void {
    if (sameDraft(this.lists.get(id), submitted)) this.deleteList(id);
  }
  // After a save, a still-pending draft must address saved rows by their
  // server ids, or its next save would re-create them under new ids.
  remapListOptionKeys(id: string, keys: ReadonlyMap<string, string>): void {
    const draft = this.lists.get(id);
    if (!draft || keys.size === 0) return;
    this.lists.set(id, { ...draft, options: remapOptionKeys(draft.options, keys) });
  }
  // Like settleDimension: an options save can settle after its editor closed
  // or was reopened, so the retained draft and the editor mounted now (with or
  // without a retained draft) both adopt the server ids.
  settleListOptionKeys(id: string, keys: ReadonlyMap<string, string>): void {
    if (keys.size === 0) return;
    this.remapListOptionKeys(id, keys);
    this.listEditors.get(id)?.(keys);
  }
  attachListEditor(id: string, apply: (keys: ReadonlyMap<string, string>) => void): () => void {
    this.listEditors.set(id, apply);
    return () => {
      if (this.listEditors.get(id) === apply) this.listEditors.delete(id);
    };
  }
  pruneListTagIds(removedIds: ReadonlySet<string>): void {
    if (removedIds.size === 0) return;
    let changed = false;
    for (const [id, draft] of this.lists) {
      const options = draft.options.map((option) => ({
        ...option,
        tagIds: option.tagIds.filter((tagId) => !removedIds.has(tagId)),
        excludeTagIds: option.excludeTagIds.filter((tagId) => !removedIds.has(tagId)),
      }));
      if (options.some((option, index) => option.tagIds.length !== draft.options[index]?.tagIds.length
        || option.excludeTagIds.length !== draft.options[index].excludeTagIds.length)) {
        this.lists.set(id, { ...draft, options });
        changed = true;
      }
    }
    if (changed) {
      this.listPruneRevision += 1;
      this.notify();
    }
  }

  getDimension(id: string): DimensionDraft | undefined { return this.dimensions.get(id); }
  setDimension(id: string, draft: DimensionDraft): void { this.dimensions.set(id, draft); }
  deleteDimension(id: string): void { this.dimensions.delete(id); }
  clearDimensionIfUnchanged(id: string, submitted: DimensionDraft): void {
    if (sameDraft(this.dimensions.get(id), submitted)) this.deleteDimension(id);
  }
  // A save can settle after its editor closed, or after it was reopened as a
  // new instance. The retained draft and whichever editor is mounted now both
  // take the settlement, so neither keeps a pending base or an id-less row.
  settleDimension(id: string, settlement: DimensionSettlement): void {
    const draft = this.dimensions.get(id);
    if (draft) this.dimensions.set(id, applyDimensionSettlement(draft, settlement));
    this.dimensionEditors.get(id)?.(settlement);
  }
  attachDimensionEditor(id: string, apply: (settlement: DimensionSettlement) => void): () => void {
    this.dimensionEditors.set(id, apply);
    return () => {
      if (this.dimensionEditors.get(id) === apply) this.dimensionEditors.delete(id);
    };
  }
}

const DraftContext = createContext<PromptDraftStore | null>(null);

export function PromptDraftProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new PromptDraftStore());
  // A failed lazy chunk must not auto-reload over unsaved library edits.
  useEffect(() => registerUnsavedWork(store.hasDrafts), [store]);
  return <DraftContext value={store}>{children}</DraftContext>;
}

// Null outside App keeps standalone component tests independent of the shell.
export function usePromptDraftStore(): PromptDraftStore | null {
  return useContext(DraftContext);
}
