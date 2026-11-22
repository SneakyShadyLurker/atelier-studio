import type { TagDimension, VariableList } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { ReplaceOptionInput } from '../../api/prompts';
import {
  useListMutationPending,
  usePatchList,
  useReplaceOptions,
  useUpdateOption,
} from '../../hooks/usePromptMutations';
import { useDraftList } from '../../hooks/useDraftList';
import { useIsPhone } from '../../hooks/useIsPhone';
import { usePromptImageContext } from '../../hooks/usePromptImageContext';
import { useTaskModelChoice } from '../../hooks/useTaskModelChoice';
import { useTextModelGate } from '../../hooks/useTextModelGate';
import { runWhenReachable } from '../../lib/focus';
import { goToTextModels } from '../../lib/textModelsNav';
import { useAtelierStore } from '../../store/atelier';
import { Disclosure } from '../Disclosure';
import { I } from '../icons/I';
import { useRowReorder } from './useRowReorder';
import DescribeListDialog from '../DescribeListDialog';
import TextModelNote from '../TextModelNote';
import InlineFieldChrome from './InlineFieldChrome';
import MoreMenu from './MoreMenu';
import ListReview from './ListReview/index';
import { applyReview, isFresh, remapReviewKeys, type ListReview as Review } from './listReview';
import { acceptedIds } from './reviewDecisions';
import { plural } from './reviewParts';
import { PROMPT_LIBRARY_NAME_MAX_CHARS } from '@atelier/shared/prompt-limits';
import styles from './index.module.css';
import btn from '../../styles/buttons.module.css';
import {
  draftedOption,
  newOptionKey,
  remapOptionKeys,
  restoreOptionWeight,
  usePromptDraftStore,
  type ListDraft,
  type OptionDraft,
  type WeightRestore,
} from './draftStore';

type TagPolarity = 'off' | 'require' | 'exclude';

function polarityOf(draft: OptionDraft, tagId: string): TagPolarity {
  if (draft.tagIds.includes(tagId)) return 'require';
  if (draft.excludeTagIds.includes(tagId)) return 'exclude';
  return 'off';
}

interface ListEditorProps {
  list: VariableList;
  dimensions: readonly TagDimension[];
  /** Phone: the head's More offers Delete (the rail's delete stays the desktop path). */
  onDelete?: (() => void) | undefined;
}

// Long enough to reach Undo, like the other undo toasts.
const REVIEW_UNDO_TOAST_MS = 5000;

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

type ListHeadAction = 'draft' | 'discard' | 'delete';
type OptionRowAction = 'tags' | 'remove';

export default function ListEditor({ list, dimensions, onDelete }: ListEditorProps) {
  const isPhone = useIsPhone();
  // Draft stays enabled without a text model; with none configured at all it
  // opens the note under the pressed control (phone: the surviving More).
  const textModelGate = useTextModelGate();
  const draftButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const [textNoteAnchor, setTextNoteAnchor] = useState<RefObject<HTMLButtonElement | null> | null>(null);
  const formId = useId();
  const nameId = useId();
  const addToast = useAtelierStore((state) => state.addToast);
  const dismissToast = useAtelierStore((state) => state.dismissToast);
  const removeToast = useAtelierStore((state) => state.removeToast);
  const replaceOptions = useReplaceOptions();
  const patchList = usePatchList();
  const updateOption = useUpdateOption();
  const draftStore = usePromptDraftStore();
  const [name, setName] = useState(() => draftStore?.getList(list.id)?.name ?? list.name);
  const [drafts, setDrafts] = useState(() => draftStore?.getList(list.id)?.options ?? optionDrafts(list));
  // An open draft review (spec R5.9): it reopens on mount only while it is
  // fresh against the rows, and is dropped as soon as they no longer match.
  const [review, setReview] = useState<Review | null>(() => {
    const stored = draftStore?.getListReview(list.id);
    return stored !== undefined && isFresh(stored.base, drafts) ? stored : null;
  });
  if (review !== null && !isFresh(review.base, drafts)) setReview(null);
  // Keys the review surface: each new or reopened review mounts fresh.
  const [reviewMount, setReviewMount] = useState(0);
  useEffect(() => {
    if (review === null) draftStore?.deleteListReview(list.id);
    else draftStore?.setListReview(list.id, review);
  }, [draftStore, list.id, review]);
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
  // weight and expanded state edited meanwhile survive. An open review's base
  // follows, so it stays fresh against the settled rows.
  const applyOptionKeys = useCallback((keys: ReadonlyMap<string, string>) => {
    setDrafts((current) => remapOptionKeys(current, keys));
    setReview((current) => (current === null ? null : remapReviewKeys(current, keys)));
  }, []);
  useEffect(
    () => draftStore?.attachListEditor(list.id, applyOptionKeys),
    [applyOptionKeys, draftStore, list.id],
  );
  const restoreWeight = useCallback((restore: WeightRestore) => {
    setDrafts((current) => restoreOptionWeight(current, restore));
  }, []);
  useEffect(
    () => draftStore?.attachListWeightEditor(list.id, restoreWeight),
    [draftStore, list.id, restoreWeight],
  );

  const formRef = useRef<HTMLFormElement | null>(null);
  const addOptionRef = useRef<HTMLButtonElement | null>(null);
  // Set when a review ends; the option table mounts again and takes focus then.
  const focusRowsAfterReviewRef = useRef(false);
  // The rows as they stand, for a draft's answer and an Undo pressed later.
  const liveDraftsRef = useRef(drafts);
  useEffect(() => { liveDraftsRef.current = drafts; }, [drafts]);
  // The review's Undo toast. Its Undo writes this editor's state, so the toast
  // goes when the editor does rather than offering a dead action.
  const undoToastRef = useRef<string | null>(null);
  useEffect(() => () => {
    if (undoToastRef.current !== null) removeToast(undoToastRef.current);
  }, [removeToast]);
  const { modelId: imageModelId } = usePromptImageContext();
  const modelChoice = useTaskModelChoice('list-draft', imageModelId);

  useEffect(() => {
    if (!clampAnnouncement && flashClampKey === null) return undefined;
    const timer = window.setTimeout(() => {
      setClampAnnouncement('');
      setFlashClampKey(null);
    }, 1500);
    return () => { window.clearTimeout(timer); };
  }, [clampAnnouncement, flashClampKey]);

  const draftList = useDraftList({
    name: trimmedName,
    getRows: () => liveDraftsRef.current,
    commitChoice: modelChoice.commit,
    // A seed fills an empty list, whose rows are blank placeholders (R6.1).
    onSeed: (options) => { setDrafts(options.map(draftedOption)); },
    // A populated list's answer opens the review; Rework again replaces an open one.
    onReview: (next) => {
      setReview(next);
      setReviewMount((count) => count + 1);
    },
  });

  const drafting = draftList.status === 'seed-prompt'
    || draftList.status === 'rework-prompt'
    || draftList.status === 'drafting'
    || draftList.status === 'clarifying';
  const busy = pending || drafting;

  const startDraft = () => {
    // The next draft is based on the rows as they stand now, so the last
    // review's Undo goes: pressed under the open dialog it would swap the rows
    // out from under the request.
    if (undoToastRef.current !== null) {
      removeToast(undoToastRef.current);
      undoToastRef.current = null;
    }
    // Each dialog opens on the saved model pick; a cancelled choice is not kept.
    modelChoice.reset();
    draftList.draft(review?.mode);
  };

  // R5.7, R5.8: end the review, applying its accepted changes or none, with an
  // Undo that reopens it while the rows are still the very ones this action
  // left (any edit, a tag change or a key settlement retires it).
  const endReview = (outcome: 'apply' | 'discard') => {
    if (review === null) return;
    const closed = review;
    const before = drafts;
    const count = acceptedIds(closed).length;
    if (outcome === 'apply' && count === 0) return;
    const left = outcome === 'apply' ? applyReview(before, closed, newOptionKey) : before;
    setDrafts(left);
    setReview(null);
    focusRowsAfterReviewRef.current = true;
    if (undoToastRef.current !== null) removeToast(undoToastRef.current);
    let undone = false;
    const toastId = addToast(
      outcome === 'apply' ? `Applied ${plural(count, 'change', 'changes')}` : 'Changes discarded',
      outcome === 'apply' ? 'success' : 'soft',
      REVIEW_UNDO_TOAST_MS,
      {
        label: 'Undo',
        onClick: () => {
          if (undone) return;
          undone = true;
          undoToastRef.current = null;
          dismissToast(toastId);
          if (liveDraftsRef.current !== left) return;
          setDrafts(before);
          setReview(closed);
          setReviewMount((mount) => mount + 1);
        },
      },
      () => {
        if (undoToastRef.current === toastId) undoToastRef.current = null;
      },
    );
    undoToastRef.current = toastId;
  };

  // The review held focus and leaves with Apply or Discard: the first option
  // takes it (Add option on an emptied list), so the keyboard stays in the form.
  useEffect(() => {
    if (review !== null || !focusRowsAfterReviewRef.current) return;
    focusRowsAfterReviewRef.current = false;
    // A save still in flight disables the option fields; Add option is free then.
    const target = formRef.current?.querySelector<HTMLElement>('[data-option-input]:not(:disabled)') ?? addOptionRef.current;
    runWhenReachable(() => { target?.focus(); }, target);
  }, [review]);

  const acceptedCount = review === null ? 0 : acceptedIds(review).length;
  const draftLabel = drafting ? 'Drafting…' : review !== null ? 'Rework again' : 'Draft List';

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
    const key = newOptionKey();
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
    // Writes nothing when the row already reads that way: a blur that changes
    // nothing must leave the rows state as it is, or it would retire an Undo.
    const settle = (weight: number) => {
      const weightInput = String(weight);
      if (draft.weight === weight && draft.weightInput === weightInput) return;
      updateDraft(key, (row) => ({ ...row, weight, weightInput }));
    };
    const raw = draft.weightInput.trim();
    if (raw.length === 0) {
      settle(draft.weight);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      settle(draft.weight);
      return;
    }
    const rounded = Math.round(parsed);
    const clamped = Math.min(100, Math.max(0, rounded));
    const wasClamped = clamped !== parsed;
    settle(clamped);
    if (wasClamped) announceClamp(key, clamped);

    // R5.11: only a weight the user changed here is sent. A blur that leaves
    // the row's weight as it was sends nothing, also when that weight differs
    // from the server's (an applied AI reweight, saved with the list).
    if (clamped === draft.weight) return;
    const persisted = list.options.find((option) => option.id === key);
    if (!persisted || persisted.weight === clamped) return;
    // Back to the weight this edit started from, which after an applied
    // reweight is not the server's. Handled on the promise, not in a per-call
    // callback: those are dropped once this editor unmounts, and the failed
    // weight would stay in the retained draft and be saved with the list.
    const restore: WeightRestore = { key, attempted: clamped, previous: draft.weight };
    // With nothing else unsaved, the restored rows are the saved list again.
    const cleanAfter: ListDraft | undefined = dirty
      ? undefined
      : { name, options: drafts.map((row) => (row.key === key ? { ...row, weightInput: String(row.weight) } : row)) };
    updateOption.mutateAsync({ listId: list.id, optionId: key, patch: { weight: clamped } }).catch((error: unknown) => {
      if (draftStore) draftStore.restoreListOptionWeight(list.id, restore, cleanAfter);
      else restoreWeight(restore);
      addToast(describeError(error, "Couldn't save the option weight."), 'error');
    });
  };

  const save = () => {
    // A review leaves nothing to save until it is applied or discarded (R5.6).
    if (review !== null) return;
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

  // Keyed apart from Save list: reused, the pressed Apply would turn into the
  // submit button before its click's default action ran, and save.
  const headPrimary = review !== null ? (
    <button
      key="apply"
      className={btn.primary}
      type="button"
      aria-disabled={acceptedCount === 0}
      onClick={() => { endReview('apply'); }}
    >
      {acceptedCount === 0 ? 'Apply' : `Apply ${plural(acceptedCount, 'change', 'changes')}`}
    </button>
  ) : (
    <button key="save" className={btn.primary} type="submit" disabled={!dirty || busy || !trimmedName || trimmedName.length > PROMPT_LIBRARY_NAME_MAX_CHARS}>
      Save list
    </button>
  );

  return (
    <>
    <form
      id={formId}
      ref={formRef}
      className={`${styles.editor} ${styles.rowEditor}`}
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
          kicker="Variable list"
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
          {/* Phone (design 5, Prompt Library editors): the head is one row,
              title + Save (Apply during a review) + More; Draft (Rework
              again), Discard and Delete live behind More. */}
          {!isPhone && (
            <button
              ref={draftButtonRef}
              className={btn.ai}
              type="button"
              data-tip={!trimmedName ? 'Name the list first' : 'Describe what to add or change, and pick the text model that writes it'}
              // Stays enabled on a full list: Rework is still open (R4.1).
              disabled={!trimmedName || busy}
              onClick={() => {
                if (textModelGate.availability === 'none') setTextNoteAnchor(draftButtonRef);
                else startDraft();
              }}
            >
              <I.sparkle aria-hidden="true" />
              {draftLabel}
            </button>
          )}
          {!isPhone && review !== null && (
            <button className={btn.secondary} type="button" onClick={() => { endReview('discard'); }}>
              Discard
            </button>
          )}
          {headPrimary}
          {isPhone && (
            <MoreMenu<ListHeadAction>
              triggerLabel="More list actions"
              menuLabel="Variable list actions"
              triggerRef={moreButtonRef}
              items={[
                { action: 'draft', label: draftLabel, icon: <I.sparkle />, disabled: !trimmedName || busy },
                ...(review !== null ? [{ action: 'discard' as const, label: 'Discard', icon: <I.close />, disabled: busy }] : []),
                ...(onDelete ? [{ action: 'delete' as const, label: 'Delete list', icon: <I.trash />, danger: true, disabled: busy }] : []),
              ]}
              onSelect={(action) => {
                // The menu has already closed (instant selection), so the
                // note opens after it, anchored to the More button.
                if (action === 'draft' && textModelGate.availability === 'none') setTextNoteAnchor(moreButtonRef);
                else if (action === 'draft') startDraft();
                else if (action === 'discard') endReview('discard');
                else onDelete?.();
              }}
            />
          )}
        </div>
      </div>

      <div className={styles.listToolbar} data-zone="entry">
        <span className={styles.listToolbarTitle}>
          Options, {drafts.length}
        </span>
        <button ref={addOptionRef} className={btn.secondary} type="button" onClick={addOption} disabled={review !== null}>
          + Add option
        </button>
      </div>

      <div className={styles.listScroll} data-zone="body">
        {review !== null ? (
          // Read-only during a review: the sheet takes the option table's place.
          <ListReview
            key={reviewMount}
            review={review}
            onChange={setReview}
            onApply={() => { endReview('apply'); }}
            scopeRef={formRef}
            shortcutsEnabled={draftList.dialogMode === null}
          />
        ) : (<>
        {drafts.length > 0 && (
          <p className={styles.bodyNote}>
            {isPhone
              ? 'The number beside each option is its weight: how often it is rolled (0 pin only, 1 default). Tags are under ⋯.'
              : 'The number beside each option is its weight: how often it is rolled. 0 means pin only; 1 is the default.'}
          </p>
        )}
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
                  data-option-input=""
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
                {!isPhone && (
                  <button
                    className={`${btn.secondary} ${styles.rowButton}`}
                    type="button"
                    aria-expanded={draft.expanded}
                    aria-controls={`${formId}-tags-${draft.key}`}
                    aria-label={`${draft.expanded ? 'Hide' : 'Show'} tags for ${draft.value || `option ${index + 1}`}`}
                    onClick={() => {
                      updateDraft(draft.key, (row) => ({ ...row, expanded: !row.expanded }));
                    }}
                  >
                    <I.tag /> Tags
                  </button>
                )}
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
                {isPhone ? (
                  // Phone row: name, weight and More; Tags and Remove behind it.
                  <MoreMenu<OptionRowAction>
                    triggerLabel={`More actions for ${draft.value || `option ${index + 1}`}`}
                    menuLabel={`Option ${index + 1} actions`}
                    items={[
                      { action: 'tags', label: draft.expanded ? 'Hide tags' : 'Show tags', icon: <I.tag /> },
                      { action: 'remove', label: 'Remove option', icon: <I.close />, danger: true },
                    ]}
                    onSelect={(action) => {
                      if (action === 'tags') updateDraft(draft.key, (row) => ({ ...row, expanded: !row.expanded }));
                      else setDrafts((current) => current.filter((row) => row.key !== draft.key));
                    }}
                  />
                ) : (
                  <button
                    className={btn.iconAction}
                    type="button"
                    data-tip="Remove option"
                    aria-label={`Remove option ${draft.value || index + 1}`}
                    onClick={() => {
                      setDrafts((current) => current.filter((row) => row.key !== draft.key));
                    }}
                  >
                    <I.close />
                  </button>
                )}
                <Disclosure
                  id={`${formId}-tags-${draft.key}`}
                  open={draft.expanded}
                  lazy
                  className={styles.tagDisclosure}
                  contentClassName={styles.tagDisclosureContent}
                >
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
                </Disclosure>
              </div>
            ))}
          </div>
        )}
        </>)}
      </div>
      {clampAnnouncement ? (
        <div role="status" aria-live="polite" className="srOnly">
          {clampAnnouncement}
        </div>
      ) : null}
    </form>
    {/* Outside the form: keys typed in a dialog never reach the review's
        form-scoped shortcuts or the form's submit. */}
    {textNoteAnchor !== null && (
      <TextModelNote
        open
        action="Draft List"
        anchorRef={textNoteAnchor}
        escape="top-level"
        navigateToTextModels={goToTextModels}
        onClose={() => { setTextNoteAnchor(null); }}
      />
    )}
    {draftList.dialogMode !== null && (
      <DescribeListDialog
        mode={draftList.dialogMode === 'rework' ? 'populated' : draftList.dialogMode}
        question={draftList.clarifyQuestion}
        choice={draftList.choice}
        onChoice={draftList.setChoice}
        full={draftList.full}
        busy={draftList.status === 'drafting'}
        error={draftList.error}
        notice={draftList.notice}
        {...(review !== null ? { initialText: review.instructions } : {})}
        modelChoice={modelChoice}
        onSubmit={draftList.submitDescription}
        onCancel={draftList.cancelDialog}
      />
    )}
    </>
  );
}
