import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { PROMPT_LIBRARY_NAME_MAX_CHARS } from '@atelier/shared/prompt-limits';
import { aiFillMeasuredLength, hasAiFillTokens } from '@atelier/shared/ai-fill';
import type { PromptTemplate, VariableList } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { useCreateTemplate, usePatchTemplate, useTemplatePatchPending } from '../../hooks/usePromptMutations';
import { useAtelierStore } from '../../store/atelier';
import { useDraftTemplate } from '../../hooks/useDraftTemplate';
import { useIsPhone } from '../../hooks/useIsPhone';
import { usePromptImageContext } from '../../hooks/usePromptImageContext';
import { useTaskModelChoice } from '../../hooks/useTaskModelChoice';
import { useTextModelGate } from '../../hooks/useTextModelGate';
import { runWhenReachable } from '../../lib/focus';
import { goToTextModels } from '../../lib/textModelsNav';
import { I } from '../icons/I';
import { Disclosure } from '../Disclosure';
import { Meta } from '../Meta';
import InlineFieldChrome from './InlineFieldChrome';
import MoreMenu from './MoreMenu';
import DescribeTemplateDialog from '../DescribeTemplateDialog';
import { acceptedIds, previewBody, type TemplateReview as Review } from './templateReview';
// The full path: on a case-insensitive disk './TemplateReview' resolves to templateReview.ts.
import TemplateReview from './TemplateReview/index';
import TextModelNote from '../TextModelNote';
import styles from './index.module.css';
import btn from '../../styles/buttons.module.css';
import { usePromptDraftStore, type TemplateDraft } from './draftStore';

import { VAR_TOKEN_RE, referencedVarNames as referencedLists } from '@atelier/shared/template-tokens';

// Ai-fill instructions do not count against the cap (aiFillMeasuredLength).
function resolvedLength(body: string, lists: readonly VariableList[]): number {
  const byName = new Map(lists.map((list) => [list.name, list]));
  const expanded = body.replaceAll(VAR_TOKEN_RE, (_token, name: string) => {
    const list = byName.get(name.trim());
    return list?.options[0]?.value ?? '';
  });
  return aiFillMeasuredLength(expanded);
}

const subscribeNoop = () => () => undefined;
// Long enough to reach Undo, like the other undo toasts.
const REWORK_UNDO_TOAST_MS = 5000;
const getNotPending = () => false;

interface TemplateEditorProps {
  template: PromptTemplate | null;
  initialName?: string;
  variableLists: readonly VariableList[];
  onCreated?: (created: PromptTemplate) => void;
  /** Phone: the head's More offers Delete (the rail's delete stays the desktop path). */
  onDelete?: (() => void) | undefined;
}

type TemplateHeadAction = 'draft' | 'discard' | 'delete';

const changeCount = (count: number) => `${String(count)} ${count === 1 ? 'change' : 'changes'}`;

export default function TemplateEditor({ template, initialName = '', variableLists, onCreated, onDelete }: TemplateEditorProps) {
  const isPhone = useIsPhone();
  // Draft stays enabled without a text model; with none configured at all it
  // opens the note under the pressed control (phone: the surviving More).
  const textModelGate = useTextModelGate();
  const draftButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const [textNoteAnchor, setTextNoteAnchor] = useState<RefObject<HTMLButtonElement | null> | null>(null);
  const nameId = useId();
  const bodyId = useId();
  const bodyHelpId = useId();
  const refsPanelId = useId();
  const addToast = useAtelierStore((state) => state.addToast);
  const dismissToast = useAtelierStore((state) => state.dismissToast);
  const removeToast = useAtelierStore((state) => state.removeToast);
  const createTemplate = useCreateTemplate();
  const patchTemplate = usePatchTemplate();
  const draftStore = usePromptDraftStore();
  const sharedCreatePending = useSyncExternalStore(
    draftStore?.subscribe ?? subscribeNoop,
    draftStore?.getTemplateCreatePending ?? getNotPending,
  );
  const draftKey = template?.id ?? 'new';
  const [name, setName] = useState(() => draftStore?.getTemplate(draftKey)?.name ?? template?.name ?? initialName);
  const initialBody = () => draftStore?.getTemplate(draftKey)?.body ?? template?.body ?? '';
  const [body, setBody] = useState(initialBody);
  // An open rework review (spec R8.3): it reopens on mount only against the
  // body it was made from; the mirror effect below drops any other.
  const [review, setReview] = useState<Review | null>(() => {
    const stored = draftStore?.getTemplateReview(draftKey);
    return stored?.base === initialBody() ? stored : null;
  });
  // Keys the review surface: each new or reopened review mounts fresh (its
  // first change current and focused, its folds closed).
  const [reviewMount, setReviewMount] = useState(0);
  const [refsOpen, setRefsOpen] = useState(false);
  useEffect(() => {
    if (review === null) draftStore?.deleteTemplateReview(draftKey);
    else draftStore?.setTemplateReview(draftKey, review);
  }, [draftKey, draftStore, review]);

  // During a review every readout reflects the body as Apply would leave it.
  const shownBody = review === null ? body : previewBody(review);
  const tokens = referencedLists(shownBody);
  const knownLists = new Set(variableLists.map((list) => list.name));
  const unknownTokens = tokens.filter((token) => !knownLists.has(token));
  const meter = resolvedLength(shownBody, variableLists);
  const meterExcludesFills = hasAiFillTokens(shownBody);
  const changed = template
    ? name.trim() !== template.name || body !== template.body
    : name.trim().length > 0 || body.trim().length > 0;
  // A save an earlier instance of this editor started is still in flight after
  // a remount; its optimistic write makes the submitted draft look clean, so
  // the draft must survive until that request settles.
  const sharedPatchPending = useTemplatePatchPending(template?.id ?? null);
  const pending = sharedCreatePending || createTemplate.isPending || patchTemplate.isPending || sharedPatchPending;
  useEffect(() => {
    if (changed) draftStore?.setTemplate(draftKey, { name, body });
    else if (!pending) draftStore?.deleteTemplate(draftKey);
  }, [body, changed, draftKey, draftStore, name, pending]);

  const formRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Set when a review ends: the textarea mounts again and takes focus then.
  const focusBodyOnMountRef = useRef(false);
  const bindTextarea = (node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    if (node === null || !focusBodyOnMountRef.current) return;
    focusBodyOnMountRef.current = false;
    runWhenReachable(() => { node.focus(); }, node);
  };
  // The body as it stands, for an Undo pressed after later edits.
  const liveBodyRef = useRef(body);
  useEffect(() => { liveBodyRef.current = body; }, [body]);
  // The rework's Undo toast. Its Undo writes this editor's state, so the toast
  // goes when the editor does rather than offering a dead action.
  const undoToastRef = useRef<string | null>(null);
  useEffect(() => () => {
    if (undoToastRef.current !== null) removeToast(undoToastRef.current);
  }, [removeToast]);
  const { modelId: imageModelId } = usePromptImageContext();
  const modelChoice = useTaskModelChoice('template-draft', imageModelId);
  const applyDraftedBody = (generated: string) => {
    // The body field is disabled while a draft runs, so `body` is still the
    // text the draft was based on.
    const previous = body;
    setBody(generated);
    runWhenReachable(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(generated.length, generated.length);
    });
    if (previous.trim() === '') return;
    // A whole body is the answer to a seed, whose body is blank. Should one ever
    // arrive over a filled body, the text it replaced stays one Undo away.
    if (undoToastRef.current !== null) removeToast(undoToastRef.current);
    let undone = false;
    const toastId = addToast('Template reworked', 'success', REWORK_UNDO_TOAST_MS, {
      label: 'Undo',
      onClick: () => {
        if (undone) return;
        undone = true;
        undoToastRef.current = null;
        dismissToast(toastId);
        setBody(previous);
      },
    }, () => {
      if (undoToastRef.current === toastId) undoToastRef.current = null;
    });
    undoToastRef.current = toastId;
  };
  const draftHook = useDraftTemplate({
    name: name.trim(),
    getCurrentBody: () => body,
    commitChoice: modelChoice.commit,
    onBody: applyDraftedBody,
    // A rework answer opens the review; Rework again replaces an open one.
    onReview: (next) => {
      setReview(next);
      setReviewMount((count) => count + 1);
    },
    onWarnings: (warnings) => {
      for (const warning of warnings) {
        addToast(warning, 'soft');
      }
    },
  });

  const busy = pending
    || draftHook.status === 'drafting'
    || draftHook.status === 'clarifying'
    || draftHook.status === 'seed-prompt'
    || draftHook.status === 'rework-prompt';
  const trimmedName = name.trim();

  const startDraft = () => {
    // The next draft is based on the body as it stands now, so the last
    // rework's Undo goes: pressed under the open dialog it would swap the body
    // out from under the request.
    if (undoToastRef.current !== null) {
      removeToast(undoToastRef.current);
      undoToastRef.current = null;
    }
    // Each dialog opens on the saved model pick; a cancelled choice is not kept.
    modelChoice.reset();
    draftHook.draft();
  };

  // R5.3, R5.4: end the review, applying its accepted changes or none, with
  // an Undo that reopens it while the body is still what this action left.
  const endReview = (outcome: 'apply' | 'discard') => {
    if (review === null) return;
    const closed = review;
    const count = acceptedIds(closed).length;
    if (outcome === 'apply' && count === 0) return;
    const left = outcome === 'apply' ? previewBody(closed) : body;
    setBody(left);
    setReview(null);
    focusBodyOnMountRef.current = true;
    if (undoToastRef.current !== null) removeToast(undoToastRef.current);
    let undone = false;
    const toastId = addToast(
      outcome === 'apply' ? `Applied ${changeCount(count)}` : 'Rework discarded',
      outcome === 'apply' ? 'success' : 'soft',
      REWORK_UNDO_TOAST_MS,
      {
        label: 'Undo',
        onClick: () => {
          if (undone) return;
          undone = true;
          undoToastRef.current = null;
          dismissToast(toastId);
          if (liveBodyRef.current !== left) return;
          setBody(closed.base);
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

  const acceptedCount = review === null ? 0 : acceptedIds(review).length;
  const applyLabel = acceptedCount === 0 ? 'Apply' : `Apply ${changeCount(acceptedCount)}`;
  // Keyed apart from Save template: reused, the pressed Apply would turn into
  // the submit button before its click's default action ran, and save.
  const applyButton = review !== null && (
    <button
      key="apply"
      className={btn.primary}
      type="button"
      aria-disabled={acceptedCount === 0}
      onClick={() => { endReview('apply'); }}
    >
      {applyLabel}
    </button>
  );
  const draftLabel = busy ? 'Drafting…' : review !== null ? 'Rework again' : 'Draft Template';

  const save = () => {
    const trimmedName = name.trim();
    // A review leaves nothing to save until it is applied (R8.1).
    if (review !== null) return;
    if (busy || !trimmedName || trimmedName.length > PROMPT_LIBRARY_NAME_MAX_CHARS || !body.trim()) return;
    const submitted: TemplateDraft = { name, body };
    const done = () => {
      draftStore?.clearTemplateIfUnchanged(draftKey, submitted);
      addToast(template ? 'Template saved' : 'Template created');
    };
    const fail = (error: unknown) => {
      addToast(describeError(error, "Couldn't save the template."), 'error');
    };
    if (template) {
      patchTemplate.mutateAsync({
        id: template.id,
        body: { name: trimmedName, body },
      }).then(done).catch(fail);
    } else {
      if (draftStore && !draftStore.beginTemplateCreate()) return;
      createTemplate.mutateAsync({
        name: trimmedName,
        body,
      }).then((created) => {
        draftStore?.clearTemplateIfUnchanged(draftKey, submitted);
        draftStore?.moveTemplate(draftKey, created.id);
        onCreated?.(created);
        addToast('Template created');
      }).catch(fail).finally(() => { draftStore?.endTemplateCreate(); });
    }
  };

  const meterMeta = (
    <Meta className={meter >= MAX_PROMPT_CHARS ? styles.meterDanger : styles.meter} items={[
      `${String(meter)} / ${String(MAX_PROMPT_CHARS)}`,
      // The note is editing guidance; a review's head needs the row for Discard and Apply.
      meterExcludesFills && review === null ? <span key="fills" className={styles.aiFillNote}>AI fills excluded, they expand at Generate</span> : null,
    ]} />
  );

  return (
    <>
    <form
      className={`${styles.editor} ${styles.templateEditor}`}
      ref={formRef}
      role="form"
      aria-label={template ? `Edit template ${template.name}` : 'Create template'}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className={styles.editorHead} data-zone="head">
        <InlineFieldChrome
          id={nameId}
          kicker="Template"
          value={name}
          ariaLabel="Template name"
          placeholder="New template"
          onChange={(event) => { setName(event.target.value); }}
          disabled={busy}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <div className={styles.headActions}>
          {/* Phone (design 5, Prompt Library editors): the head is one row,
              title + Save (Apply during a review) + More; Draft (Rework again),
              Discard and Delete live behind More and the meter moves into the
              body. */}
          {!isPhone && (
            <button
              type="button"
              ref={draftButtonRef}
              className={btn.ai}
              onClick={() => {
                if (textModelGate.availability === 'none') setTextNoteAnchor(draftButtonRef);
                else startDraft();
              }}
              disabled={!trimmedName || busy}
              data-tip={!trimmedName ? 'Name the template first' : 'Describe what to draft or what to change, and pick the text model that writes it'}
            >
              <I.sparkle aria-hidden="true" />
              {draftLabel}
            </button>
          )}
          {!isPhone && meterMeta}
          {!isPhone && review !== null && (
            <button className={btn.secondary} type="button" onClick={() => { endReview('discard'); }}>
              Discard
            </button>
          )}
          {review !== null ? applyButton : (
            <button
              key="save"
              className={btn.primary}
              type="submit"
              disabled={!changed || busy || !trimmedName || trimmedName.length > PROMPT_LIBRARY_NAME_MAX_CHARS || !body.trim()}
            >
              Save template
            </button>
          )}
          {isPhone && (
            <MoreMenu<TemplateHeadAction>
              triggerLabel="More template actions"
              menuLabel="Template actions"
              triggerRef={moreButtonRef}
              items={[
                { action: 'draft', label: draftLabel, icon: <I.sparkle />, disabled: !trimmedName || busy },
                ...(review !== null ? [{ action: 'discard' as const, label: 'Discard', icon: <I.close />, disabled: busy }] : []),
                ...(onDelete ? [{ action: 'delete' as const, label: 'Delete template', icon: <I.trash />, danger: true, disabled: busy }] : []),
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

      <div className={styles.editorBody} data-zone="body">
        {review !== null ? (
          // Read-only during a review: the tracked sheet takes the textarea's box.
          <div className={`${styles.field} ${styles.editorBodyField}`}>
            <span className={styles.inlineLabel}>Body</span>
            <TemplateReview
              key={reviewMount}
              review={review}
              onChange={setReview}
              onApply={() => { endReview('apply'); }}
              scopeRef={formRef}
            />
          </div>
        ) : (
          <label className={`${styles.field} ${styles.editorBodyField}`}>
            <span className={styles.inlineLabel}>Body</span>
            <textarea
              id={bodyId}
              ref={bindTextarea}
              aria-label="Body"
              aria-describedby={bodyHelpId}
              className={styles.monoArea}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={body}
              disabled={busy}
              onChange={(event) => { setBody(event.target.value); }}
            />
          </label>
        )}
        {review === null && (
          <p id={bodyHelpId} className={styles.microcopy}>
            Tokens: <code>{'{{var::name}}'}</code>, <code>{'{{random::a::b}}'}</code>,{' '}
            <code>{'{{pick::…}}'}</code>, <code>{'{{roll::1d6}}'}</code>, <code>{'{{user}}'}</code>. Full reference in ⓘ.
          </p>
        )}
        {isPhone && meterMeta}
      </div>

      <div className={styles.editorFoot} data-zone="foot">
        <button
          type="button"
          className={styles.disclosureToggle}
          aria-expanded={refsOpen}
          aria-controls={refsPanelId}
          disabled={busy}
          onClick={() => { setRefsOpen((v) => !v); }}
        >
          <span className={styles.disclosureCaret} data-open={refsOpen ? 'true' : 'false'} aria-hidden="true">
            <I.caret />
          </span>
          Referenced lists, {tokens.length}
        </button>
        <Disclosure id={refsPanelId} open={refsOpen}>
          <div className={styles.tokenPanel}>
            {tokens.length === 0 ? (
              <p className={styles.microcopy}>No variable-list tokens found.</p>
            ) : (
              <div className={styles.chips}>
                {tokens.map((token) => (
                  <span key={token} className={unknownTokens.includes(token) ? styles.dangerChip : styles.chip}>
                    {token}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Disclosure>
        {unknownTokens.length > 0 && (
          <p className={styles.warning}>Unknown list: {unknownTokens.join(', ')}</p>
        )}
      </div>
    </form>
    {textNoteAnchor !== null && (
      <TextModelNote
        open
        action="Draft Template"
        anchorRef={textNoteAnchor}
        escape="top-level"
        navigateToTextModels={goToTextModels}
        onClose={() => { setTextNoteAnchor(null); }}
      />
    )}
    {draftHook.dialogMode !== null && (
      <DescribeTemplateDialog
        mode={draftHook.dialogMode}
        question={draftHook.clarifyQuestion}
        onSubmit={draftHook.submitDescription}
        onCancel={draftHook.cancelDialog}
        busy={draftHook.status === 'drafting'}
        error={draftHook.error}
        notice={draftHook.notice}
        {...(review !== null ? { initialText: review.instructions } : {})}
        modelChoice={modelChoice}
      />
    )}
    </>
  );
}
