import type { TagDimension, VariableList } from '@atelier/shared';
import { MAX_OPTIONS_PER_LIST } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useCallback, useEffect, useId, useState } from 'react';
import type { ReplaceOptionInput } from '../../api/prompts';
import {
  useListMutationPending,
  usePatchList,
  useReplaceOptions,
  useUpdateOption,
} from '../../hooks/usePromptMutations';
import { useDraftList } from '../../hooks/useDraftList';
import { useAtelierStore } from '../../store/atelier';
import { I } from '../icons/I';
import { useRowReorder } from './useRowReorder';
import DescribeListDialog from '../DescribeListDialog';
import InlineFieldChrome from './InlineFieldChrome';
import { PROMPT_LIBRARY_NAME_MAX_CHARS } from '@atelier/shared/prompt-limits';
import styles from './index.module.css';
import btn from '../../styles/buttons.module.css';
import { remapOptionKeys, usePromptDraftStore, type ListDraft, type OptionDraft } from './draftStore';

type TagPolarity = 'off' | 'require' | 'exclude';

function polarityOf(draft: OptionDraft, tagId: string): TagPolarity {
  if (draft.tagIds.includes(tagId)) return 'require';
  if (draft.excludeTagIds.includes(tagId)) return 'exclude';
  return 'off';
}

interface ListEditorProps {
  list: VariableList;
  dimensions: readonly TagDimension[];
}

function optionDrafts(list: VariableList): readonly OptionDraft[] {
  return list.options.map((option) => ({
    key: option.id,
    value: option.value,
    tagIds: option.tagIds,
    excludeTagIds: option.excludeTagIds ?? [],
    weight: option.weight,
    weightInput: String(option.weight),
    expanded: false,
  }));
}

function savedRows(drafts: readonly OptionDraft[]): readonly OptionDraft[] {
  return drafts.filter((draft) => draft.value.trim().length > 0);
}

// Existing rows carry their option id so the PUT keeps identity (and picker
// pins) across text edits and reorders. Unsaved `draft:*` keys are never sent.
function normalized(drafts: readonly OptionDraft[], persistedIds: ReadonlySet<string>): readonly ReplaceOptionInput[] {
  return savedRows(drafts)
    .map((draft, index) => ({
      ...(persistedIds.has(draft.key) && !draft.key.startsWith('draft:') ? { id: draft.key } : {}),
      value: draft.value.trim(),
      tagIds: [...draft.tagIds].sort((a, b) => a.localeCompare(b)),
      // Always sent: the route preserves omitted metadata, so an absent key could
      // never clear an exclusion the operator just removed.
      excludeTagIds: [...draft.excludeTagIds].sort((a, b) => a.localeCompare(b)),
      sortOrder: index,
      weight: draft.weight,
    }));
}

// Pairs each submitted row with the server's option at the same sort position
// and returns the local keys whose server identity differs (new rows, or rows
// the server re-created). A row sent without an id also maps from the
// placeholder id the optimistic cache gave it, which is the key an editor
// reopened from that cache during the save holds.
function serverKeyMap(
  listId: string,
  submitted: readonly OptionDraft[],
  sent: readonly ReplaceOptionInput[],
  response: VariableList,
): ReadonlyMap<string, string> {
  const ordered = [...response.options].sort((a, b) => a.sortOrder - b.sortOrder);
  const keys = new Map<string, string>();
  submitted.forEach((row, index) => {
    const option = ordered[index];
    if (option?.value !== row.value.trim()) return;
    if (option.id !== row.key) keys.set(row.key, option.id);
    if (sent[index]?.id === undefined) keys.set(`optimistic:${listId}:${index}`, option.id);
  });
  return keys;
}

function sameOptions(a: readonly ReplaceOptionInput[], b: readonly ReplaceOptionInput[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    if (!right) return false;
    return left.value === right.value
      && left.sortOrder === right.sortOrder
      && (left.weight ?? 1) === (right.weight ?? 1)
      && left.tagIds.length === right.tagIds.length
      && left.tagIds.every((tagId, tagIndex) => tagId === right.tagIds[tagIndex])
      && (left.excludeTagIds ?? []).length === (right.excludeTagIds ?? []).length
      && (left.excludeTagIds ?? []).every((tagId, tagIndex) => tagId === (right.excludeTagIds ?? [])[tagIndex]);
  });
}

export default function ListEditor({ list, dimensions }: ListEditorProps) {
  const formId = useId();
  const nameId = useId();
  const addToast = useAtelierStore((state) => state.addToast);
  const replaceOptions = useReplaceOptions();
  const patchList = usePatchList();
  const updateOption = useUpdateOption();
  const draftStore = usePromptDraftStore();
  const [name, setName] = useState(() => draftStore?.getList(list.id)?.name ?? list.name);
  const [drafts, setDrafts] = useState(() => draftStore?.getList(list.id)?.options ?? optionDrafts(list));
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [flashClampKey, setFlashClampKey] = useState<string | null>(null);
  const [clampAnnouncement, setClampAnnouncement] = useState('');
  const persistedIds = new Set(list.options.map((option) => option.id));
  const original = normalized(optionDrafts(list), persistedIds);
  const nextOptions = normalized(drafts, persistedIds);
  const trimmedName = name.trim();
  const nameDirty = trimmedName.length > 0 && trimmedName !== list.name;
  const optionsDirty = !sameOptions(original, nextOptions);
  const dirty = nameDirty || optionsDirty;
  // A save started by an earlier instance of this editor (closed and reopened
  // meanwhile) counts too: its ids are not settled yet, so a second Save or a
  // weight PATCH would address rows by stale keys.
  const sharedPending = useListMutationPending(list.id);
  const pending = sharedPending || replaceOptions.isPending || patchList.isPending || updateOption.isPending;
  useEffect(() => {
    if (dirty) draftStore?.setList(list.id, { name, options: drafts });
    else if (!pending) draftStore?.deleteList(list.id);
  }, [dirty, draftStore, drafts, list.id, name, pending]);

  // Functional update only: saved rows take their server ids, and text, order,
  // weight and expanded state edited meanwhile survive.
  const applyOptionKeys = useCallback((keys: ReadonlyMap<string, string>) => {
    setDrafts((current) => remapOptionKeys(current, keys));
  }, []);
  useEffect(
    () => draftStore?.attachListEditor(list.id, applyOptionKeys),
    [applyOptionKeys, draftStore, list.id],
  );

  const currentValues = nextOptions.map((option) => option.value);

  const appendEntries = (entries: string[]) => {
    setDrafts((current) => {
      const seen = new Set(current.map((d) => d.value.trim().toLowerCase()));
      const additions: OptionDraft[] = [];
      for (const raw of entries) {
        const value = raw.trim();
        const lc = value.toLowerCase();
        if (value.length === 0 || seen.has(lc)) continue;
        seen.add(lc);
        additions.push({
          key: `draft:${Date.now()}:${Math.random().toString(36).slice(2)}:${additions.length}`,
          value,
          tagIds: [],
          excludeTagIds: [],
          weight: 1,
          weightInput: '1',
          expanded: false,
        });
      }
      return additions.length === 0 ? current : [...current, ...additions];
    });
  };

  useEffect(() => {
    if (!clampAnnouncement && flashClampKey === null) return undefined;
    const timer = window.setTimeout(() => {
      setClampAnnouncement('');
      setFlashClampKey(null);
    }, 1500);
    return () => { window.clearTimeout(timer); };
  }, [clampAnnouncement, flashClampKey]);

  const draftList = useDraftList({
    listId: list.id,
    name: trimmedName,
    getCurrentValues: () => currentValues,
    onEntries: appendEntries,
  });

  const drafting = draftList.status === 'seed-prompt'
    || draftList.status === 'drafting'
    || draftList.status === 'clarifying';
  const busy = pending || drafting;

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

  const updateDraft = (key: string, map: (draft: OptionDraft) => OptionDraft) => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? map(draft) : draft)));
  };

  // Cycles off -> require -> exclude -> off. One control per tag rather than a
  // separate polarity switch: the chip already reads as the tag's state.
  const cycleTag = (key: string, tagId: string) => {
    updateDraft(key, (draft) => {
      const current = polarityOf(draft, tagId);
      const without = {
        tagIds: draft.tagIds.filter((id) => id !== tagId),
        excludeTagIds: draft.excludeTagIds.filter((id) => id !== tagId),
      };
      if (current === 'off') return { ...draft, ...without, tagIds: [...without.tagIds, tagId] };
      if (current === 'require') return { ...draft, ...without, excludeTagIds: [...without.excludeTagIds, tagId] };
      return { ...draft, ...without };
    });
  };

  const addOption = () => {
    const key = `draft:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    setDrafts((current) => [
      { key, value: '', tagIds: [], excludeTagIds: [], weight: 1, weightInput: '1', expanded: false },
      ...current,
    ]);
    setFreshKey(key);
  };

  const announceClamp = (key: string, weight: number) => {
    setFlashClampKey(key);
    setClampAnnouncement(`Weight clamped to ${weight}`);
  };

  const onLocalWeightChange = (key: string, value: string) => {
    updateDraft(key, (row) => ({ ...row, weightInput: value }));
  };

  const commitWeight = (key: string) => {
    const draft = drafts.find((row) => row.key === key);
    if (!draft) return;
    const raw = draft.weightInput.trim();
    if (raw.length === 0) {
      updateDraft(key, (row) => ({ ...row, weightInput: String(row.weight) }));
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      updateDraft(key, (row) => ({ ...row, weightInput: String(row.weight) }));
      return;
    }
    const rounded = Math.round(parsed);
    const clamped = Math.min(100, Math.max(0, rounded));
    const wasClamped = clamped !== parsed;
    updateDraft(key, (row) => ({ ...row, weight: clamped, weightInput: String(clamped) }));
    if (wasClamped) announceClamp(key, clamped);

    const persisted = list.options.find((option) => option.id === key);
    if (!persisted || persisted.weight === clamped) return;
    updateOption.mutate(
      { listId: list.id, optionId: key, patch: { weight: clamped } },
      {
        onError: (error) => {
          updateDraft(key, (row) => ({ ...row, weight: persisted.weight, weightInput: String(persisted.weight) }));
          addToast(describeError(error, "Couldn't save the option weight."), 'error');
        },
      },
    );
  };

  const save = () => {
    if (!trimmedName || trimmedName.length > PROMPT_LIBRARY_NAME_MAX_CHARS || pending) return;
    const tasks: Promise<unknown>[] = [];
    const submittedRows = savedRows(drafts);
    const sentOptions = nextOptions;
    // Mirrors the id settlement applied to the retained draft, so the final
    // clear still recognises a draft nobody edited during the save.
    let submitted: ListDraft = { name, options: drafts };
    if (nameDirty) tasks.push(patchList.mutateAsync({ id: list.id, name: trimmedName }));
    if (optionsDirty) {
      // Settles on its own success, whatever the name PATCH does: the server
      // now holds these rows, so later weight PATCHes and text saves must
      // address them by their server ids.
      tasks.push(replaceOptions.mutateAsync({ listId: list.id, options: sentOptions }).then((response) => {
        const keys = serverKeyMap(list.id, submittedRows, sentOptions, response);
        if (keys.size === 0) return;
        if (draftStore) draftStore.settleListOptionKeys(list.id, keys);
        else applyOptionKeys(keys);
        submitted = { ...submitted, options: remapOptionKeys(submitted.options, keys) };
      }));
    }
    if (tasks.length === 0) return;
    Promise.all(tasks)
      .then(() => {
        draftStore?.clearListIfUnchanged(list.id, submitted);
        addToast('Variable list saved');
      })
      .catch((error: unknown) => {
        addToast(describeError(error, "Couldn't save the variable list."), 'error');
      });
  };

  return (
    <form
      id={formId}
      className={styles.editor}
      role="form"
      aria-label={`Edit variable list ${list.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className={styles.editorHead} data-zone="head">
        <InlineFieldChrome
          id={nameId}
          kicker="VARIABLE LIST"
          value={name}
          ariaLabel="Variable list name"
          disabled={busy}
          onChange={(event) => { setName(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <div className={styles.headActions}>
          <button
            className={btn.ai}
            type="button"
            data-tip={
              !trimmedName ? 'Name the list first'
                : drafts.length >= MAX_OPTIONS_PER_LIST ? `List is at the ${MAX_OPTIONS_PER_LIST}-option limit`
                : currentValues.length === 0 ? 'Describe the list and generate up to 10 starter entries'
                : 'Generate ~20 more entries with Kimi K3'
            }
            disabled={!trimmedName || busy || drafts.length >= MAX_OPTIONS_PER_LIST}
            onClick={() => { draftList.draft(); }}
          >
            <I.sparkle aria-hidden="true" />
            {drafting ? 'Drafting…' : 'Draft List'}
          </button>
          <button className={btn.primary} type="submit" disabled={!dirty || busy || !trimmedName || trimmedName.length > PROMPT_LIBRARY_NAME_MAX_CHARS}>
            Save list
          </button>
        </div>
      </div>

      <div className={styles.listToolbar} data-zone="entry">
        <span className={styles.listToolbarTitle}>
          Options · {drafts.length}
        </span>
        <button className={btn.secondary} type="button" onClick={addOption}>
          + Add option
        </button>
      </div>

      <div className={styles.listScroll} data-zone="body">
        {drafts.length === 0 ? (
          <p className={styles.listEmpty}>Add options to make this list usable in templates.</p>
        ) : (
          <div className={styles.optionTable}>
            {drafts.map((draft, index) => (
              <div key={draft.key} className={styles.optionRow} ref={reorder.registerRow(draft.key)}>
                <button
                  type="button"
                  className={styles.gripBtn}
                  aria-label={`Reorder ${draft.value || `option ${index + 1}`}`}
                  data-dragging={reorder.draggingKey === draft.key ? 'true' : 'false'}
                  {...reorder.gripHandlers(draft.key)}
                  onKeyDown={(event) => { reorder.keyboardHandlers(draft.key)?.onKeyDown(event); }}
                >
                  <I.grip />
                </button>
                <input
                  className={styles.optionInput}
                  aria-label={`Option ${index + 1}${draft.value ? `: ${draft.value}` : ''}`}
                  value={draft.value}
                  disabled={busy}
                  autoCorrect="off"
                  spellCheck={false}
                  ref={(node) => {
                    if (node && draft.key === freshKey) {
                      node.focus();
                      setFreshKey(null);
                    }
                  }}
                  onChange={(event) => {
                    updateDraft(draft.key, (row) => ({ ...row, value: event.target.value }));
                  }}
                  onKeyDown={(event) => {
                    reorder.keyboardHandlers(draft.key)?.onKeyDown(event);
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addOption();
                    }
                  }}
                />
                <button
                  className={btn.secondary}
                  type="button"
                  aria-expanded={draft.expanded}
                  aria-label={`${draft.expanded ? 'Hide' : 'Show'} tags for ${draft.value || `option ${index + 1}`}`}
                  onClick={() => {
                    updateDraft(draft.key, (row) => ({ ...row, expanded: !row.expanded }));
                  }}
                >
                  <I.tag /> Tags
                </button>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  className={styles.weightInput}
                  value={draft.weightInput}
                  aria-label="How often this option appears when picked randomly. 0 means it is never picked randomly and can only be chosen by pinning. 1 is the default, and higher numbers appear proportionally more often. Range 0 to 100."
                  aria-describedby={`weight-help-${draft.key}`}
                  data-flash-clamp={flashClampKey === draft.key ? 'true' : undefined}
                  data-tuned={draft.weight !== 1 ? 'true' : 'false'}
                  disabled={busy}
                  onChange={(event) => { onLocalWeightChange(draft.key, event.target.value); }}
                  onBlur={() => { commitWeight(draft.key); }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                />
                <span id={`weight-help-${draft.key}`} className={styles.weightHelp}>
                  {draft.weight === 0 ? 'Manual only' : `Weight ${draft.weight !== 1 ? `(${draft.weight}x)` : ''}`}
                </span>
                <button
                  className={btn.icon}
                  type="button"
                  aria-label={`Remove option ${draft.value || index + 1}`}
                  onClick={() => {
                    setDrafts((current) => current.filter((row) => row.key !== draft.key));
                  }}
                >
                  <I.close />
                </button>
                {draft.expanded && (
                  <div className={styles.tagPanel}>
                    {dimensions.length === 0 ? (
                      <p className={styles.microcopy}>Create dimensions before assigning tags.</p>
                    ) : dimensions.map((dimension) => (
                      <fieldset key={dimension.id} className={styles.tagGroup}>
                        <legend>{dimension.name}</legend>
                        <div className={styles.chips}>
                          {dimension.tags.map((tag) => {
                            const polarity = polarityOf(draft, tag.id);
                            const chipClass = polarity === 'require'
                              ? styles.chipSelected
                              : polarity === 'exclude' ? styles.chipExcluded : styles.chipButton;
                            const stateWord = polarity === 'require'
                              ? 'required'
                              : polarity === 'exclude' ? 'excluded' : 'not set';
                            return (
                              <button
                                key={tag.id}
                                type="button"
                                className={chipClass}
                                // Tri-state, so aria-pressed (binary) would misreport
                                // "excluded" as "not required". The state is in the name.
                                aria-label={`${tag.label}: ${stateWord}`}
                                data-polarity={polarity}
                                onClick={() => { cycleTag(draft.key, tag.id); }}
                              >
                                {polarity === 'exclude' ? `− ${tag.label}` : tag.label}
                              </button>
                            );
                          })}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {draftList.dialogMode !== null && (
        <DescribeListDialog
          {...(draftList.clarifyQuestion !== null ? { question: draftList.clarifyQuestion } : {})}
          busy={draftList.status === 'drafting'}
          error={draftList.error}
          onSubmit={(text) => { draftList.submitDescription(text); }}
          onCancel={() => { draftList.cancelDialog(); }}
        />
      )}
      {clampAnnouncement ? (
        <div role="status" aria-live="polite" className="srOnly">
          {clampAnnouncement}
        </div>
      ) : null}
    </form>
  );
}
