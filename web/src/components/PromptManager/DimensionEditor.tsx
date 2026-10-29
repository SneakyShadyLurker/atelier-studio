import type { TagDimension } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useCallback, useEffect, useId, useState } from 'react';
import type { ReplaceTagInput } from '../../api/prompts';
import { useDimensionMetadataPending, useDimensionTagsPending, useReplaceTags } from '../../hooks/usePromptMutations';
import { useAtelierStore } from '../../store/atelier';
import { I } from '../icons/I';
import { useRowReorder } from './useRowReorder';
import InlineFieldChrome from './InlineFieldChrome';
import styles from './index.module.css';
import btn from '../../styles/buttons.module.css';
import {
  applyDimensionSettlement,
  settleTagDrafts,
  usePromptDraftStore,
  type DimensionDraft,
  type DimensionSettlement,
  type TagDraft,
} from './draftStore';

// A tag may not parent itself or any of its own descendants. The server rejects
// cycles anyway; filtering here keeps the impossible choices out of the picker.
function descendantIds(drafts: readonly TagDraft[], rootId: string): ReadonlySet<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const draft of drafts) {
      if (draft.id !== undefined && draft.parentId !== null && out.has(draft.parentId) && !out.has(draft.id)) {
        out.add(draft.id);
        grew = true;
      }
    }
  }
  return out;
}

interface DimensionEditorProps {
  dimension: TagDimension;
  // Carries the description too — both persist through the same dimension PATCH.
  onRename: (name: string, description?: string) => Promise<unknown> | undefined;
  // True while the parent's rename mutation is in flight, so Save (and the name
  // field) disable during a rename — matching ListEditor/TemplateEditor's `busy`.
  renamePending?: boolean;
}

function tagDrafts(dimension: TagDimension): readonly TagDraft[] {
  return dimension.tags.map((tag) => ({ id: tag.id, key: tag.id, label: tag.label, parentId: tag.parentId ?? null }));
}

function normalized(drafts: readonly TagDraft[]): readonly ReplaceTagInput[] {
  const kept = drafts.filter((draft) => draft.label.trim().length > 0);
  // A blank row is dropped, so the server deletes it; its children must not
  // keep pointing at it or the whole replace is rejected as an unknown parent.
  const keptIds = new Set(kept.flatMap((draft) => (draft.id === undefined ? [] : [draft.id])));
  return kept.map((draft, index) => {
    // parentId is always sent: the route preserves a stored parent when the key is
    // absent, so omitting it here would make clearing a parent impossible.
    const parentId = draft.parentId !== null && keptIds.has(draft.parentId) ? draft.parentId : null;
    const tag = { label: draft.label.trim(), sortOrder: index, parentId };
    return draft.id === undefined ? tag : { id: draft.id, ...tag };
  });
}

// Removing a row also unparents its direct children; grandchildren keep their
// still-valid parent.
function withoutTagRow(drafts: readonly TagDraft[], key: string): readonly TagDraft[] {
  const removedId = drafts.find((row) => row.key === key)?.id;
  return drafts
    .filter((row) => row.key !== key)
    .map((row) => (removedId !== undefined && row.parentId === removedId ? { ...row, parentId: null } : row));
}

// Pairs each submitted row with the saved tag at the same sort position, keyed
// by the row's stable local key. A row sent without an id also maps from the
// placeholder id the optimistic cache gave it, which is the key an editor
// reopened from that cache during the save holds.
function savedTagIdsByKey(submitted: readonly TagDraft[], saved: TagDimension): ReadonlyMap<string, string> {
  const rows = submitted.filter((draft) => draft.label.trim().length > 0);
  const ordered = [...saved.tags].sort((a, b) => a.sortOrder - b.sortOrder);
  const ids = new Map<string, string>();
  rows.forEach((row, index) => {
    const tag = ordered[index];
    if (tag?.label !== row.label.trim() || (row.id !== undefined && row.id !== tag.id)) return;
    ids.set(row.key, tag.id);
    if (row.id === undefined) ids.set(`optimistic:${saved.id}:${index}`, tag.id);
  });
  return ids;
}

// A restored field resumes only if it was edited or is mid-save; a clean one
// takes the current server value, which may have changed while unmounted.
function restoredField(
  restored: { value: string; base: string | null } | undefined,
  server: string,
): { value: string; base: string | null } {
  if (restored === undefined || restored.value.trim() === restored.base) return { value: server, base: server };
  return restored;
}

function sameTags(a: readonly ReplaceTagInput[], b: readonly ReplaceTagInput[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    if (right === undefined) return false;
    return left.id === right.id && left.label === right.label && left.sortOrder === right.sortOrder
      && (left.parentId ?? null) === (right.parentId ?? null);
  });
}

export default function DimensionEditor({ dimension, onRename, renamePending = false }: DimensionEditorProps) {
  const nameId = useId();
  const meaningId = useId();
  const addToast = useAtelierStore((state) => state.addToast);
  const replaceTags = useReplaceTags();
  // Includes a replacement an earlier instance of this editor started before
  // it was closed and reopened: until it settles, the rows it inserted have no
  // ids here, and a second Save would insert them again.
  const sharedTagsPending = useDimensionTagsPending(dimension.id);
  const tagsPending = sharedTagsPending || replaceTags.isPending;
  // Likewise for a name or description save: the parent's observer is new
  // after a remount and idle, but the earlier PATCH is still in the cache.
  const metadataPending = useDimensionMetadataPending(dimension.id) || renamePending;
  const draftStore = usePromptDraftStore();
  const restored = draftStore?.getDimension(dimension.id);
  const serverDescription = dimension.description ?? '';
  const restoredName = restoredField(restored && { value: restored.name, base: restored.nameBase }, dimension.name);
  const restoredDescription = restoredField(
    restored && { value: restored.description, base: restored.descriptionBase },
    serverDescription,
  );
  const [name, setName] = useState(restoredName.value);
  const [nameBase, setNameBase] = useState(restoredName.base);
  // Re-seed the editable name when the dimension's name changes externally
  // (e.g. an AI apply/rescue setQueryData, or a background refetch) — the
  // component is keyed by id, not name, so without this the local copy goes
  // stale and a subsequent Save would clobber the external rename. Only a
  // clean field (still equal to its base) follows: a local edit is kept, and a
  // submitted one has a null base until its save settles, so this editor's own
  // optimistic write and its rollback never replace the submitted text.
  const [prevDimensionName, setPrevDimensionName] = useState(dimension.name);
  if (dimension.name !== prevDimensionName) {
    setPrevDimensionName(dimension.name);
    if (name.trim() === nameBase) {
      setName(dimension.name);
      setNameBase(dimension.name);
    }
  }
  const [drafts, setDrafts] = useState(() => restored?.tags ?? tagDrafts(dimension));
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [description, setDescription] = useState(restoredDescription.value);
  const [descriptionBase, setDescriptionBase] = useState(restoredDescription.base);
  const [prevDescription, setPrevDescription] = useState(serverDescription);
  if (serverDescription !== prevDescription) {
    setPrevDescription(serverDescription);
    if (description.trim() === descriptionBase) {
      setDescription(serverDescription);
      setDescriptionBase(serverDescription);
    }
  }
  const original = normalized(tagDrafts(dimension));
  const nextTags = normalized(drafts);
  const trimmedName = name.trim();
  const nameDirty = trimmedName.length > 0 && trimmedName !== dimension.name;
  const trimmedDescription = description.trim();
  const descriptionDirty = trimmedDescription !== (dimension.description ?? '');
  const tagsDirty = !sameTags(original, nextTags);
  // Match ListEditor/TemplateEditor: the name persists only via "Save
  // dimension" (no commit-on-blur auto-save), so all three shared-chrome
  // editors commit identically. See InlineFieldChrome's name-save contract.
  const dirty = nameDirty || descriptionDirty || tagsDirty;
  // A submitted field looks clean against its own optimistic write, so a
  // pending base keeps the draft until the save settles and fills it.
  const basePending = nameBase === null || descriptionBase === null;
  useEffect(() => {
    if (dirty || basePending) {
      draftStore?.setDimension(dimension.id, { name, description, nameBase, descriptionBase, tags: drafts });
    } else if (!tagsPending && !metadataPending) draftStore?.deleteDimension(dimension.id);
  }, [
    basePending, description, descriptionBase, dimension.id, dirty, draftStore, drafts, metadataPending, name, nameBase,
    tagsPending,
  ]);

  // Functional updates only: a pending base is filled and saved ids are adopted
  // without writing back any field value, so edits made meanwhile survive.
  const applySettlement = useCallback((settlement: DimensionSettlement) => {
    if (settlement.kind === 'tags') {
      setDrafts((current) => settleTagDrafts(current, settlement));
      return;
    }
    const { nameBase: settledName, descriptionBase: settledDescription } = settlement.bases;
    if (settledName !== undefined) setNameBase((base) => base ?? settledName);
    if (settledDescription !== undefined) setDescriptionBase((base) => base ?? settledDescription);
  }, []);
  useEffect(
    () => draftStore?.attachDimensionEditor(dimension.id, applySettlement),
    [applySettlement, dimension.id, draftStore],
  );

  const draftKeys = drafts.map((draft) => draft.key);
  const reorder = useRowReorder(draftKeys, (from, to) => {
    setDrafts((current) => {
      const next = current.slice();
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(to, 0, moved);
      return next;
    });
  });

  const addTag = () => {
    const key = `draft:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    setDrafts((current) => [{ key, label: '', parentId: null }, ...current]);
    setFreshKey(key);
  };

  const save = () => {
    if (tagsPending || metadataPending) return;
    const tasks: Promise<unknown>[] = [];
    const submittedTags = drafts;
    // Mirrors every settlement applied to the retained draft, so the final
    // clear still recognises a draft nobody edited during the save.
    let submitted: DimensionDraft = {
      name,
      description,
      nameBase: nameDirty ? null : nameBase,
      descriptionBase: descriptionDirty ? null : descriptionBase,
      tags: submittedTags,
    };
    const settle = (settlement: DimensionSettlement) => {
      if (draftStore) draftStore.settleDimension(dimension.id, settlement);
      else applySettlement(settlement);
      submitted = applyDimensionSettlement(submitted, settlement);
    };
    if (nameDirty || descriptionDirty) {
      const fromName = dimension.name;
      const fromDescription = serverDescription;
      const settleBases = (nextName: string, nextDescription: string) => {
        settle({
          kind: 'bases',
          bases: {
            ...(nameDirty ? { nameBase: nextName } : {}),
            ...(descriptionDirty ? { descriptionBase: nextDescription } : {}),
          },
        });
      };
      if (nameDirty) setNameBase(null);
      if (descriptionDirty) setDescriptionBase(null);
      draftStore?.setDimension(dimension.id, submitted);
      tasks.push(Promise.resolve(onRename(trimmedName, descriptionDirty ? trimmedDescription : undefined)).then(
        // Success: the server now holds the submitted text. Failure: the cache
        // rolled back, so the kept text is an edit against the prior value.
        () => { settleBases(trimmedName, trimmedDescription); },
        (error: unknown) => {
          settleBases(fromName, fromDescription);
          throw error;
        },
      ));
    }
    const tagResult = tagsDirty ? replaceTags.mutateAsync({ dimId: dimension.id, tags: nextTags }).then((saved) => {
      const retainedIds = new Set(saved.tags.map((tag) => tag.id));
      draftStore?.pruneListTagIds(new Set(dimension.tags.map((tag) => tag.id).filter((id) => !retainedIds.has(id))));
      // Adopt saved ids by the submitted rows' stable keys, into whatever the
      // draft became while the request was in flight.
      settle({
        kind: 'tags',
        submitted: submittedTags,
        saved: tagDrafts(saved),
        savedIdByKey: savedTagIdsByKey(submittedTags, saved),
        persistedIds: retainedIds,
      });
      return saved;
    }) : null;
    if (tagResult) tasks.push(tagResult);
    if (tasks.length === 0) return;
    Promise.all(tasks).then(() => {
      draftStore?.clearDimensionIfUnchanged(dimension.id, submitted);
      addToast('Dimension saved');
    }).catch((error: unknown) => {
      addToast(describeError(error, "Couldn't save the dimension."), 'error');
    });
  };

  return (
    <form
      className={styles.editor}
      role="form"
      aria-label={`Edit dimension ${dimension.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className={styles.editorHead} data-zone="head">
        <InlineFieldChrome
          id={nameId}
          kicker="DIMENSION"
          value={name}
          ariaLabel="Dimension name"
          disabled={tagsPending || metadataPending}
          onChange={(event) => { setName(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <div className={styles.headActions}>
          <button className={btn.primary} type="submit" disabled={!dirty || tagsPending || metadataPending}>
            Save dimension
          </button>
        </div>
        {/* Dimension-level metadata, so it belongs in HEAD — the scroll-surface
            contract allows exactly one entry zone and that one is the Add-tag row. */}
        <label className={styles.dimensionMeaning} htmlFor={meaningId}>
          <span>Means</span>
          <input
            id={meaningId}
            className={styles.optionInput}
            value={description}
            placeholder="what this dimension asserts of an option, e.g. “the hour this reads as”"
            aria-label="Dimension description"
            disabled={tagsPending || metadataPending}
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => { setDescription(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </label>
      </div>

      <div className={styles.listToolbar} data-zone="entry">
        <span className={styles.listToolbarTitle}>Tags · {drafts.length}</span>
        <button className={btn.secondary} type="button" onClick={addTag}>
          + Add tag
        </button>
      </div>

      <div className={styles.listScroll} data-zone="body">
        {drafts.length === 0 ? (
          <p className={styles.listEmpty}>Add mutually-exclusive tags to make this dimension usable.</p>
        ) : (
          <div className={styles.optionTable}>
            {drafts.map((draft, index) => (
              <div key={draft.key} className={styles.tagRow} ref={reorder.registerRow(draft.key)}>
                <button
                  type="button"
                  className={styles.gripBtn}
                  aria-label={`Reorder ${draft.label || `tag ${index + 1}`}`}
                  data-dragging={reorder.draggingKey === draft.key ? 'true' : 'false'}
                  {...reorder.gripHandlers(draft.key)}
                  onKeyDown={(event) => { reorder.keyboardHandlers(draft.key)?.onKeyDown(event); }}
                >
                  <I.grip />
                </button>
                <input
                  className={styles.optionInput}
                  aria-label={`Tag ${index + 1}${draft.label ? `: ${draft.label}` : ''}`}
                  value={draft.label}
                  disabled={tagsPending}
                  autoCorrect="off"
                  spellCheck={false}
                  ref={(node) => {
                    if (node && draft.key === freshKey) {
                      node.focus();
                      setFreshKey(null);
                    }
                  }}
                  onChange={(event) => {
                    setDrafts((current) => current.map((row) => (
                      row.key === draft.key ? { ...row, label: event.target.value } : row
                    )));
                  }}
                  onKeyDown={(event) => {
                    reorder.keyboardHandlers(draft.key)?.onKeyDown(event);
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                />
                <select
                  className={styles.parentSelect}
                  aria-label={`Parent of ${draft.label || `tag ${index + 1}`}`}
                  value={draft.parentId ?? ''}
                  disabled={tagsPending}
                  onChange={(event) => {
                    const next = event.target.value === '' ? null : event.target.value;
                    setDrafts((current) => current.map((row) => (
                      row.key === draft.key ? { ...row, parentId: next } : row
                    )));
                  }}
                >
                  <option value="">no parent</option>
                  {drafts
                    .filter((candidate) => {
                      if (candidate.id === undefined || candidate.key === draft.key) return false;
                      if (candidate.label.trim().length === 0) return false;
                      return draft.id === undefined || !descendantIds(drafts, draft.id).has(candidate.id);
                    })
                    .map((candidate) => (
                      <option key={candidate.key} value={candidate.id}>↳ {candidate.label}</option>
                    ))}
                </select>
                <button
                  className={btn.icon}
                  type="button"
                  aria-label={`Remove tag ${draft.label || index + 1}`}
                  onClick={() => { setDrafts((current) => withoutTagRow(current, draft.key)); }}
                >
                  <I.close />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </form>
  );
}
