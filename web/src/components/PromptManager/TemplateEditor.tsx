import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { PROMPT_LIBRARY_NAME_MAX_CHARS } from '@atelier/shared/prompt-limits';
import { aiFillMeasuredLength, hasAiFillTokens } from '@atelier/shared/ai-fill';
import type { PromptTemplate, VariableList } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useCreateTemplate, usePatchTemplate, useTemplatePatchPending } from '../../hooks/usePromptMutations';
import { useAtelierStore } from '../../store/atelier';
import { useDraftTemplate } from '../../hooks/useDraftTemplate';
import { runWhenReachable } from '../../lib/focus';
import { I } from '../icons/I';
import InlineFieldChrome from './InlineFieldChrome';
import DescribeTemplateDialog from '../DescribeTemplateDialog';
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
const getNotPending = () => false;

interface TemplateEditorProps {
  template: PromptTemplate | null;
  initialName?: string;
  variableLists: readonly VariableList[];
  onCreated?: (created: PromptTemplate) => void;
}

export default function TemplateEditor({ template, initialName = '', variableLists, onCreated }: TemplateEditorProps) {
  const nameId = useId();
  const bodyId = useId();
  const bodyHelpId = useId();
  const addToast = useAtelierStore((state) => state.addToast);
  const createTemplate = useCreateTemplate();
  const patchTemplate = usePatchTemplate();
  const draftStore = usePromptDraftStore();
  const sharedCreatePending = useSyncExternalStore(
    draftStore?.subscribe ?? subscribeNoop,
    draftStore?.getTemplateCreatePending ?? getNotPending,
  );
  const draftKey = template?.id ?? 'new';
  const [name, setName] = useState(() => draftStore?.getTemplate(draftKey)?.name ?? template?.name ?? initialName);
  const [body, setBody] = useState(() => draftStore?.getTemplate(draftKey)?.body ?? template?.body ?? '');
  const [refsOpen, setRefsOpen] = useState(false);

  const tokens = referencedLists(body);
  const knownLists = new Set(variableLists.map((list) => list.name));
  const unknownTokens = tokens.filter((token) => !knownLists.has(token));
  const meter = resolvedLength(body, variableLists);
  const meterExcludesFills = hasAiFillTokens(body);
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

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftHook = useDraftTemplate({
    name: name.trim(),
    getCurrentBody: () => body,
    onBody: (generated) => {
      setBody((prev) => {
        let next: string;
        if (prev.trim() === '') {
          next = generated;
        } else if (/\s$/.test(prev)) {
          next = prev + generated;
        } else {
          next = prev + '\n\n' + generated;
        }
        runWhenReachable(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(next.length, next.length);
        });
        return next;
      });
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
    || draftHook.status === 'seed-prompt';
  const trimmedName = name.trim();

  const save = () => {
    const trimmedName = name.trim();
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

  return (
    <>
    <form
      className={styles.editor}
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
          kicker="TEMPLATE"
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
          <button
            type="button"
            className={btn.ai}
            onClick={draftHook.draft}
            disabled={!trimmedName || busy}
            data-tip={!trimmedName ? 'Name the template first' : 'Generate or continue the prompt body with the text model assigned to this task'}
          >
            <I.sparkle aria-hidden="true" />
            {busy ? 'Drafting…' : 'Draft Template'}
          </button>
          <span className={meter >= MAX_PROMPT_CHARS ? styles.meterDanger : styles.meter}>
            {meter} / {MAX_PROMPT_CHARS}
            {meterExcludesFills ? (
              <span className={styles.aiFillNote}> · AI fills excluded · they expand at Generate</span>
            ) : null}
          </span>
          <button
            className={btn.primary}
            type="submit"
            disabled={!changed || busy || !trimmedName || trimmedName.length > PROMPT_LIBRARY_NAME_MAX_CHARS || !body.trim()}
          >
            Save template
          </button>
        </div>
      </div>

      <div className={styles.editorBody} data-zone="body">
        <label className={`${styles.field} ${styles.editorBodyField}`}>
          <span>Body</span>
          <textarea
            id={bodyId}
            ref={textareaRef}
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
        <p id={bodyHelpId} className={styles.microcopy}>
          Tokens: <code>{'{{var::name}}'}</code> · <code>{'{{random::a::b}}'}</code> ·{' '}
          <code>{'{{pick::…}}'}</code> · <code>{'{{roll::1d6}}'}</code> · <code>{'{{user}}'}</code> — full reference in ⓘ.
        </p>
      </div>

      <div className={styles.editorFoot} data-zone="foot">
        <button
          type="button"
          className={styles.disclosureToggle}
          aria-expanded={refsOpen}
          disabled={busy}
          onClick={() => { setRefsOpen((v) => !v); }}
        >
          <span className={styles.disclosureCaret} data-open={refsOpen ? 'true' : 'false'} aria-hidden="true">
            <I.caret />
          </span>
          Referenced lists · {tokens.length}
        </button>
        {refsOpen && (
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
        )}
        {unknownTokens.length > 0 && (
          <p className={styles.warning}>Unknown list: {unknownTokens.join(', ')}</p>
        )}
      </div>
    </form>
    {draftHook.dialogMode !== null && (
      <DescribeTemplateDialog
        mode={draftHook.dialogMode}
        question={draftHook.clarifyQuestion}
        onSubmit={draftHook.submitDescription}
        onCancel={draftHook.cancelDialog}
        busy={draftHook.status === 'drafting'}
        error={draftHook.error}
      />
    )}
    </>
  );
}
