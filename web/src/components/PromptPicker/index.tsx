import { MAX_PROMPT_CHARS } from '@atelier/shared';
import type { PromptTemplate } from '@atelier/shared';
import { aiFillMeasuredLength, hasAiFillTokens, stripCardNotesToken } from '@atelier/shared/ai-fill';
import { toPreviewSegments } from './aiFillPreview';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { usePromptLibrary } from '../../hooks/usePromptLibrary';
import { useIsPromptPickerSheet } from '../../hooks/useIsPhone';
import { useModalChrome } from '../../hooks/useModalChrome';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useAbortableMutation } from '../../hooks/useAbortableMutation';
import { resolve, collectVarOccurrences, selectableOptions, applyPinsToTemplateBody } from '../../lib/promptResolver';
import type { VarOccurrence } from '../../lib/promptResolver';
import { buildAiFillRequest } from '../../lib/resolveAiFillItem';
import { resolveAiFill } from '../../api/aiFill';
import { buildSweepRolls } from '../../lib/buildSweepRolls';
import { isAbortError } from '../../lib/abort';
import { fallbackVirtualRows, virtualizedHeight } from '../../lib/virtualWindow';
import { nextSeed } from '../../lib/seed';
import { useAtelierStore } from '../../store/atelier';
import { I } from '../icons/I';
import ConfirmDialog from '../ConfirmDialog';
import RollQueueList from '../RollQueueList';
import type { ChipSelectOption } from '../Composer/ChipSelect';
import AxisRow from './AxisRow';
import AdvancedSection from './AdvancedSection';
import BrainstormPhase from './BrainstormPhase';
import { buildAxisListItems } from './subjectDividers';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

interface PromptPickerProps {
  open: boolean;
  onClose: () => void;
  targetContextLine?: ReactNode;
  modelOptions: readonly ChipSelectOption<string>[];
  modelId: string;
  onModelChange?: (value: string) => void;
}

const TEMPLATE_ROW_HEIGHT = 66;
const TEMPLATE_FALLBACK_ROWS = 16;
const noopModelChange = () => { /* noop */ };

type PendingQueueClearAction =
  | { type: 'template'; template: PromptTemplate }
  | { type: 'back' };

export function promptTemplateItemKey(templates: readonly PromptTemplate[], index: number): string | number {
  return templates[index]?.id ?? index;
}

export default function PromptPicker({
  open,
  onClose,
  targetContextLine,
  modelOptions,
  modelId,
  onModelChange = noopModelChange,
}: PromptPickerProps) {
  const isSheet = useIsPromptPickerSheet();
  const titleId = useId();
  const searchId = useId();
  const portalRootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const axisMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const templateScrollRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewTextRef = useRef<HTMLPreElement | null>(null);
  // Owns the Simulate request: superseded by a re-run, aborted on reset/close
  // and on unmount (Composer unmount, or an Enhance hiding the picker).
  const simulateRequest = useAbortableMutation();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [rollPulse, setRollPulse] = useState(0);
  // Simulate's AI-fill resolution: `simulation` is keyed by the local-resolved
  // text it was built from, so it auto-hides the instant a re-roll/pin/template
  // change makes `result.text` diverge (no effect needed — pure derivation).
  const [simulating, setSimulating] = useState(false);
  const [simulation, setSimulation] = useState<{ readonly forText: string; readonly filled: string } | null>(null);
  const [brainstorming, setBrainstorming] = useState(false);
  const [pendingQueueClear, setPendingQueueClear] = useState<PendingQueueClearAction | null>(null);
  const [pendingSweepConfirm, setPendingSweepConfirm] = useState(false);
  const promptLibrary = usePromptLibrary();
  const draft = useAtelierStore((state) => state.promptPickerDraft);
  const rollQueue = useAtelierStore((state) => state.draft.rollQueue);
  const setPickerTemplate = useAtelierStore((state) => state.setPickerTemplate);
  const setPickerPin = useAtelierStore((state) => state.setPickerPin);
  const clearPickerPin = useAtelierStore((state) => state.clearPickerPin);
  const setPickerSeed = useAtelierStore((state) => state.setPickerSeed);
  const setPickerLockSeed = useAtelierStore((state) => state.setPickerLockSeed);
  const clearRollQueue = useAtelierStore((state) => state.clearRollQueue);
  const removeQueuedRoll = useAtelierStore((state) => state.removeQueuedRoll);
  const reorderQueuedRolls = useAtelierStore((state) => state.reorderQueuedRolls);
  const stashRoll = useAtelierStore((state) => state.stashRoll);
  const setPickerSweep = useAtelierStore((state) => state.setPickerSweep);
  const clearPickerSweep = useAtelierStore((state) => state.clearPickerSweep);
  const setDraft = useAtelierStore((state) => state.setDraft);
  const addToast = useAtelierStore((state) => state.addToast);

  const data = promptLibrary.data;
  const templates = data?.templates ?? [];
  const selectedTemplate = templates.find((template) => template.id === draft.templateId) ?? null;
  const seed = draft.seed;
  // Sweep/axis occurrence keys are positional and MUST come from the
  // macro-resolved body at the current seed — the shape resolve() pins against
  // — not the raw template.body. An unpicked {{random::}} branch carrying a
  // {{var::X}} token shifts later same-list indices, so raw-body keys would not
  // re-resolve and the user could select a sweep axis that lives in an unpicked
  // branch (Finding A). Recompute when the seed or pins change the picked set.
  const result = useMemo(
    () => selectedTemplate && data
      ? resolve(selectedTemplate, data.variableLists, data.dimensions, { seed, pins: { ...draft.pins } })
      : null,
    [data, draft.pins, seed, selectedTemplate],
  );
  // Axes/sweepCount derive from the SAME resolved body — net one resolve() per
  // interaction (the three call sites used identical args; seed === draft.seed).
  const axes = useMemo<readonly VarOccurrence[]>(
    () => (result ? collectVarOccurrences(result.resolvedBody) : []),
    [result],
  );
  const filteredTemplates = useMemo(() => {
    const source = data?.templates ?? [];
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((template) =>
      template.name.toLowerCase().includes(needle) || template.body.toLowerCase().includes(needle),
    );
  }, [data?.templates, deferredQuery]);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's useVirtualizer is the canonical virtualization primitive; React Compiler escape hatch.
  const templateVirtualizer = useVirtualizer({
    count: filteredTemplates.length,
    getScrollElement: () => templateScrollRef.current,
    getItemKey: (index) => promptTemplateItemKey(filteredTemplates, index),
    estimateSize: () => TEMPLATE_ROW_HEIGHT,
    initialRect: { width: 0, height: 420 },
    overscan: 8,
  });
  const virtualTemplates = templateVirtualizer.getVirtualItems();
  const renderTemplates = virtualTemplates.length > 0
    ? virtualTemplates
    : fallbackVirtualRows(
      filteredTemplates.length,
      TEMPLATE_FALLBACK_ROWS,
      () => TEMPLATE_ROW_HEIGHT,
      (index) => filteredTemplates[index]?.id ?? index,
    );
  const templateListHeight = virtualizedHeight(
    virtualTemplates.length > 0,
    templateVirtualizer.getTotalSize(),
    filteredTemplates.length * TEMPLATE_ROW_HEIGHT,
  );
  const sweepAxis = axes.find((axis) => axis.key === draft.sweepKey) ?? null;
  const sweepCount = useMemo(() => {
    if (!result || !data || !draft.sweepKey) return 0;
    // Reuse the single resolved body/picks (same shape resolve() pins against)
    // so the swept key lines up with the resolved picks (Finding A).
    const sweepOcc = axes.find((o) => o.key === draft.sweepKey);
    if (!sweepOcc) return 0;
    const sweepKey = draft.sweepKey;
    const frozenBase: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.picks)) {
      if (key !== sweepKey) frozenBase[key] = value;
    }
    return selectableOptions(sweepOcc, axes, frozenBase, data.variableLists, data.dimensions).length;
  }, [axes, data, draft.sweepKey, result]);
  // The preview shows the AI-filled final prompt only while its source roll is
  // still on screen; any divergence falls back to the local (chip) preview.
  const localText = stripCardNotesToken(result?.text ?? '');
  const filledActive = simulation?.forText === localText ? simulation.filled : null;
  const previewText = filledActive ?? localText;
  const previewState = filledActive !== null ? 'resolved' : simulating ? 'resolving' : 'idle';
  const showFillNote = filledActive === null && hasAiFillTokens(localText);
  // While AI fills are still tokens (not yet simulated), count only the static
  // skeleton so long instructions do not false-trip the over-cap warning. Once
  // simulated/filled, previewText is the final string.
  const charCount = showFillNote ? aiFillMeasuredLength(localText) : previewText.length;
  const overCap = charCount >= MAX_PROMPT_CHARS;
  const outsideRefs = useMemo(() => [panelRef, axisMenuRef, modelMenuRef], []);
  const resetSimulation = useCallback(() => {
    simulateRequest.abort('simulation reset');
    setSimulating(false);
    setSimulation(null);
  }, [simulateRequest]);
  const handleClose = useCallback(() => {
    resetSimulation();
    setBrainstorming(false);
    onClose();
  }, [onClose, resetSimulation]);
  // Every dismissal plays the shared exit before handleClose tears down.
  const { closing, requestClose } = useExitTransition(handleClose, open);

  // Toasts render into the panel, not the portal root: the queue-clear Undo
  // must sit inside the focus trap below to be keyboard-reachable. The
  // popover ⇄ sheet switch below replaces the panel node while open, so both
  // follow it via the layout key.
  useModalChrome({ open, onCancel: requestClose, portalRef: portalRootRef, toastHostRef: panelRef, containerKey: isSheet });
  useFocusTrap(panelRef, { active: open, containerKey: isSheet });
  // Sheet mode owns a backdrop that dismisses on click — see the touch rule in
  // useOutsidePointer.
  useOutsidePointer(outsideRefs, requestClose, { enabled: open && !isSheet && pendingQueueClear === null && !pendingSweepConfirm });

  if (!open || !promptLibrary.enabled || !data) return null;

  const applyTemplate = (template: PromptTemplate) => {
    resetSimulation();
    // A new template starts a fresh roll. setPickerTemplate keeps the seed lock
    // and the prior template's seed, so without this Re-roll/Simulate would
    // silently reuse the old roll (a locked seed disables Re-roll entirely).
    setPickerLockSeed(false);
    setPickerTemplate(template.id);
    setPickerSeed(nextSeed());
  };

  const chooseTemplate = (template: PromptTemplate) => {
    if (rollQueue.length > 0 && draft.templateId !== template.id) {
      setPendingQueueClear({ type: 'template', template });
      return;
    }
    applyTemplate(template);
  };

  const backToTemplateList = () => {
    if (rollQueue.length > 0) {
      setPendingQueueClear({ type: 'back' });
      return;
    }
    resetSimulation();
    setPickerTemplate(null);
  };

  const confirmQueueClear = () => {
    const pending = pendingQueueClear;
    setPendingQueueClear(null);
    if (!pending) return;
    if (pending.type === 'template') applyTemplate(pending.template);
    else { resetSimulation(); setPickerTemplate(null); }
  };

  const reRoll = () => {
    if (draft.lockSeed) return;
    const useSeed = nextSeed();
    setPickerSeed(useSeed);
    setRollPulse((value) => value + 1);
    // Resolve the new roll's {{ai-fill}} anew from the template instruction so the
    // preview shows the freshly-resolved final prompt, not stale chips. Mirrors
    // simulate(); runSimulation aborts any in-flight call and drops the old fill.
    void runSimulation(useSeed);
  };

  // Resolve a roll's {{ai-fill}} blanks against the server so the preview shows
  // the FINAL prompt, not the locally-resolved one with inert chips. Mirrors the
  // submit chokepoint (buildAiFillRequest → resolveAiFill) but feeds the result
  // back into the on-screen preview instead of the queue. Keyed by the exact
  // local-resolved text so a later re-roll/pin silently invalidates it. No silent
  // fallback: a failure toasts and the preview stays on the chip view.
  const runSimulation = async (useSeed: number) => {
    if (!selectedTemplate) return;
    const local = resolve(selectedTemplate, data.variableLists, data.dimensions, { seed: useSeed, pins: { ...draft.pins } });
    const localText = stripCardNotesToken(local.text);
    // Repeat Simulate on a LOCKED seed → identical roll and identical derived
    // ai-fill seeds → identical result; serve the cached fill, don't re-bill.
    // When unlocked, every click advanced the seed (see simulate()), so even an
    // ai-fill-only template — whose local text doesn't change between rolls — must
    // re-resolve to fetch a fresh server fill: re-roll + resolve in one click.
    if (draft.lockSeed && simulation?.forText === localText) return;
    // No fills → the local roll already IS the final prompt; drop any stale fill.
    if (!hasAiFillTokens(local.text)) { setSimulation(null); return; }
    const build = buildAiFillRequest(local.text, data, useSeed, modelId, true);
    if (!build) { setSimulation(null); return; }
    if (build.warnings.length > 0) addToast(build.warnings[0] ?? 'Some prompt tokens could not be resolved', 'soft');
    const signal = simulateRequest.supersede();
    // Drop any stale fill so the preview falls back to the animated chip view of
    // the freshly-rolled prompt while the new resolution streams — rather than
    // freezing on the previous result (ai-fill-only rolls share local text, so
    // filledActive would otherwise keep matching the old fill).
    setSimulation(null);
    setSimulating(true);
    try {
      const filled = await resolveAiFill(build.request, signal);
      if (signal.aborted) return;
      // Empty/whitespace result → soft failure (keep the chip view), never a blank
      // box: '' is falsy, so filledActive='' would slip past the null checks and
      // render an empty "resolved" preview.
      if (filled.prompt.trim().length === 0) { addToast('AI fill returned an empty result — try again.', 'soft'); return; }
      setSimulation({ forText: localText, filled: filled.prompt });
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return;
      // Surface the server's specific reason (timeout/transient, over-length,
      // provider error) instead of a generic message, so the user knows whether to
      // retry or simplify the prompt.
      const detail = err instanceof Error && err.message.trim().length > 0 ? err.message : 'Could not resolve AI fills for the preview.';
      addToast(detail, 'soft');
    } finally {
      // Only the latest run owns the spinner; a superseded run must not clear it.
      if (simulateRequest.signal === signal) setSimulating(false);
    }
  };

  // Simulate is a pure in-window preview of the FINAL prompt: it rolls a fresh
  // representative resolution (the composer re-rolls the grammar on every
  // Generate, so no single roll is "the" prompt), resolves its {{ai-fill}} blanks
  // via the server, and scrolls the preview into view — never pasting to the
  // composer or closing. The reseed+pulse is gated on the seed lock exactly like
  // Re-roll, so a locked seed keeps the roll stable; the scroll-to-preview still
  // runs while locked, and the AI-fill resolution runs regardless of the lock so
  // even a pinned roll shows its filled final form.
  const simulate = () => {
    const useSeed = draft.lockSeed ? draft.seed : nextSeed();
    if (!draft.lockSeed) {
      setPickerSeed(useSeed);
      setRollPulse((value) => value + 1);
    }
    previewRef.current?.scrollIntoView({ block: 'nearest' });
    void runSimulation(useSeed);
  };

  // Scope Cmd/Ctrl+A to the prompt preview: without this the browser's
  // select-all spans the whole dialog. The <pre> is click-focusable
  // (tabIndex -1, not a tab stop), so the keydown lands here when the user is
  // working inside it; we select only the preview's contents.
  const selectPreviewOnly = (event: ReactKeyboardEvent<HTMLPreElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'a') return;
    // Own this keystroke the moment it's a Cmd/Ctrl+A on the preview: prevent the
    // browser default FIRST so we never fall through to whole-dialog select-all,
    // even in the (unreachable in a live window) case the Selection API is absent.
    event.preventDefault();
    const el = previewTextRef.current;
    const selection = window.getSelection();
    if (!el || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  // Copy the FINAL formulated prompt as plain text. Writing via the clipboard API
  // (text/plain only) sidesteps the rich-copy path where selecting the <pre> by
  // hand carries a text/html flavor that paste targets wrap in their own code
  // fence. Only offered once the prompt is fully resolved (previewState ===
  // 'resolved'); previewText is then the spliced final string with no live tokens.
  const copyPreview = () => {
    void navigator.clipboard.writeText(previewText)
      .then(() => { addToast('Prompt copied'); })
      .catch(() => { addToast('Could not copy prompt', 'soft'); });
  };

  const fireSweep = () => {
    if (!selectedTemplate || !draft.sweepKey) return;
    const { rolls } = buildSweepRolls(
      selectedTemplate, data.variableLists, data.dimensions, draft.pins, draft.sweepKey, draft.seed,
    );
    if (rolls.length === 0) return;
    for (const roll of rolls) stashRoll(roll);
    // Announce via the toast (persistent live region in App) — onClose() unmounts
    // this component on the next render, so a local aria-live region here would be
    // torn down before a screen reader could read it.
    addToast(`Queued ${String(rolls.length)} sweep rolls`);
    clearPickerSweep();
    requestClose();
  };
  const onSweepPrimary = () => {
    if (sweepCount > 8) { setPendingSweepConfirm(true); return; }
    fireSweep();
  };

  const panel = (
    <div
      ref={panelRef}
      className={`${styles.panel} ${isSheet ? styles.sheet : styles.popover}`}
      data-closing={closing ? 'true' : undefined}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-sheet={isSheet ? 'true' : 'false'}
    >
      <div className={styles.header} data-zone="head">
        <div>
          <h2 id={titleId}>{brainstorming ? 'Brainstorm' : 'Templates'}</h2>
          {selectedTemplate && !brainstorming ? (
            <button
              type="button"
              className={styles.backLink}
              aria-label="Back to template list"
              onClick={backToTemplateList}
            >
              <I.chevronLeft />
              {selectedTemplate.name}
            </button>
          ) : brainstorming ? (
            <p>Queue character prompts</p>
          ) : (
            <p>Choose template</p>
          )}
        </div>
        <button className={buttons.iconAction} type="button" aria-label="Close templates" data-tip="Close templates" onClick={requestClose}>
          <I.close />
        </button>
      </div>

      {brainstorming ? (
        <BrainstormPhase
          onBack={() => { setBrainstorming(false); }}
          modelOptions={modelOptions}
          modelId={modelId}
          onModelChange={onModelChange}
          modelMenuRef={modelMenuRef}
          library={data}
        />
      ) : !selectedTemplate ? (
        <div className={styles.templatePhase}>
          <div className={styles.templateEntry} data-zone="entry">
            <div className={styles.brainstormPin}>
              <button
                className={buttons.ai}
                type="button"
                onClick={() => { setBrainstorming(true); }}
              >
                <I.sparkle />
                Brainstorm
              </button>
            </div>
            <div className={styles.searchRow}>
              <label className="srOnly" htmlFor={searchId}>Search templates</label>
              <input
                id={searchId}
                type="search"
                autoComplete="off"
                enterKeyHint="search"
                spellCheck={false}
                className={styles.searchInput}
                placeholder="Search templates..."
                value={query}
                onChange={(event) => { setQuery(event.target.value); }}
              />
            </div>
          </div>
          <div ref={templateScrollRef} className={styles.scrollBody} data-zone="body">
            <ul
              className={styles.templateList}
              role="list"
              data-virtualized="templates"
              style={{ height: `${templateListHeight}px` }}
            >
              {renderTemplates.map((item) => {
                const template = filteredTemplates[item.index];
                if (!template) return null;
                return (
                <li
                  key={template.id}
                  data-index={item.index}
                  ref={templateVirtualizer.measureElement}
                  className={styles.templateVirtualRow}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <button
                    className={styles.templateButton}
                    type="button"
                    onClick={() => { chooseTemplate(template); }}
                  >
                    <span>{template.name}</span>
                    <code>{template.body}</code>
                  </button>
                </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : (
        <div className={styles.refinePhase}>
          <div className={styles.scrollBody} data-zone="body">
            <div ref={previewRef} className={styles.previewBlock} data-pulse={rollPulse}>
              <div className={styles.previewMeta}>
                <span>{filledActive !== null ? 'Simulated prompt' : 'Resolved prompt'}</span>
                <span className={overCap ? styles.meterDanger : ''}>
                  Characters: {charCount} / {MAX_PROMPT_CHARS}
                  {simulating
                    ? <span className={`${styles.aiFillNote} ${styles.aiFillNotePulse}`}> · resolving AI fills…</span>
                    : showFillNote
                      ? <span className={styles.aiFillNote}> · AI fills expand at Generate · Simulate to preview</span>
                      : null}
                </span>
              </div>
              <div className={styles.previewBody} aria-busy={simulating || undefined}>
                {simulating ? (
                  <div className={styles.scanOverlay} aria-hidden>
                    <div className={styles.scanBeam} />
                  </div>
                ) : null}
                <pre
                  ref={previewTextRef}
                  tabIndex={-1}
                  className={styles.preview}
                  data-state={previewState}
                  aria-label="Resolved prompt preview"
                  onKeyDown={selectPreviewOnly}
                >
                  {toPreviewSegments(previewText).map((seg) =>
                    seg.kind === 'text'
                      ? <span key={`text:${seg.start}`}>{seg.value}</span>
                      : (
                        <span
                          key={`aiFill:${seg.start}`}
                          className={styles.aiFillChip}
                          data-resolving={simulating ? '' : undefined}
                          data-tip="AI fills at Generate"
                        >
                          <span className={styles.aiFillSparkle} aria-hidden>✦</span>
                          <span className={styles.aiFillChipText}>{seg.value}</span>
                        </span>
                      ),
                  )}
                </pre>
                {previewState === 'resolved' ? (
                  <button
                    type="button"
                    className={`${buttons.iconAction} ${styles.copyButton}`}
                    data-size="22"
                    aria-label="Copy prompt"
                    data-tip="Copy prompt"
                    data-tip-place="below-end"
                    onClick={copyPreview}
                  >
                    <I.copy />
                  </button>
                ) : null}
              </div>
            </div>

            {rollQueue.length > 0 ? (
              <RollQueueList
                rolls={rollQueue}
                onRemove={removeQueuedRoll}
                onReorder={reorderQueuedRolls}
                onClear={clearRollQueue}
                targetContextLine={targetContextLine}
                variant="panel"
              />
            ) : null}

            {result?.warnings.length ? (
              <div className={styles.warnings} role="status">
                {result.warnings.map((warning, index) => <p key={`${String(index)}:${warning}`}>{warning}</p>)}
              </div>
            ) : null}

            {axes.length > 0 ? (
              <AdvancedSection key={selectedTemplate.id} count={axes.length}>
                <p className={styles.hint}>
                  <I.dice /> rolls each axis within the constraints · click a value to pin it · greyed options show why
                  they&rsquo;re excluded. The resolved prompt above updates as you change these — edit it before Generate.
                </p>
                <ul className={styles.axes}>
                  {buildAxisListItems(axes).map((item) =>
                    item.kind === 'divider' ? (
                      <li
                        key={`divider-${item.label}`}
                        className={styles.subjectDivider}
                        role="presentation"
                        aria-hidden="true"
                      >
                        {item.label}
                      </li>
                    ) : (
                      <li key={item.occurrence.key} className={styles.axisItem}>
                        <AxisRow
                          occurrence={item.occurrence}
                          occurrences={axes}
                          pins={draft.pins}
                          lists={data.variableLists}
                          dims={data.dimensions}
                          menuRootRef={axisMenuRef}
                          isSweep={draft.sweepKey === item.occurrence.key}
                          {...(draft.sweepKey === item.occurrence.key ? { sweepCount } : {})}
                          onToggleSweep={(key) => {
                            resetSimulation();
                            if (draft.sweepKey === key) clearPickerSweep();
                            else setPickerSweep(key);
                          }}
                          onPin={(key, optionId) => { resetSimulation(); setPickerPin(key, optionId); }}
                          onUnpin={(key) => { resetSimulation(); clearPickerPin(key); }}
                        />
                      </li>
                    ),
                  )}
                </ul>
              </AdvancedSection>
            ) : null}
          </div>

          <div className={styles.refineFoot} data-zone="foot">
            {/* Instrument strip: a readout of what this roll IS, and the two
                controls that change it. Deliberately NOT the pill vocabulary of
                the commit bar below — these operate on the roll, not on the
                sheet, and rendering both at the same weight is what made the
                footer read as six interchangeable buttons. Fixed-width icons in
                a nowrap row also keep Re-roll's position stable: as labelled
                pills the row wrapped, and Re-roll shifted whenever the lock
                label changed width. */}
            <div className={styles.instrument}>
              <span className={styles.seed}>
                Seed {seed}
                {draft.lockSeed ? ' · Locked' : ''}
                {rollQueue.length > 0 ? ` · ${String(rollQueue.length)} stashed` : ''}
              </span>
              <div className={styles.instrumentActions}>
                <button
                  className={`${buttons.icon} ${styles.instrumentButton}`}
                  type="button"
                  // Stable name on a toggle: aria-pressed carries the state, so
                  // flipping the label too would double-announce it. The
                  // readout's "· Locked" is the sighted equivalent.
                  aria-pressed={draft.lockSeed}
                  aria-label="Lock seed"
                  data-tip="Lock the seed to reproduce the exact same roll."
                  onClick={() => { setPickerLockSeed(!draft.lockSeed); }}
                >
                  <I.lock />
                </button>
                <button
                  className={`${buttons.icon} ${styles.instrumentButton}`}
                  type="button"
                  aria-label="Re-roll"
                  data-tip="Re-roll"
                  data-rolled={rollPulse > 0 ? 'true' : undefined}
                  onClick={reRoll}
                >
                  {/* Keyed so the one-shot roll animation replays per press. */}
                  <I.dice key={rollPulse} />
                </button>
              </div>
            </div>

            <div className={styles.footer}>
              {/* Hidden while a sweep is armed: sweeping IS stashing, at axis
                  granularity, so offering both invites the user to do the same
                  thing twice. */}
              {sweepAxis ? null : (
              <button
                className={`${buttons.secondary} ${styles.stashControl}`}
                type="button"
                aria-label="Stash & roll"
                data-tip={draft.lockSeed ? 'Unlock seed to stash another roll' : 'Stash this roll and re-roll'}
                disabled={draft.lockSeed || !result}
                onClick={() => {
                  if (!result) return;
                  stashRoll({
                    id: crypto.randomUUID(),
                    text: result.text,
                    seed: draft.seed,
                    source: 'template',
                    ...(draft.templateId
                      ? { provenance: { templateId: draft.templateId, rollSeed: draft.seed, pins: { ...draft.pins } } }
                      : {}),
                  });
                  setPickerSeed(nextSeed());
                  setRollPulse((value) => value + 1);
                }}
              >
                <I.plus />
                Stash & roll
              </button>
              )}
              {/* No Cancel: the sheet already dismisses from the header ×,
                  Escape, and a backdrop tap. A fourth exit was spending 76px of
                  the thumb zone to duplicate three existing ones. */}
              {sweepAxis ? (
                <button
                  className={`${buttons.primary} ${styles.primaryControl}`}
                  type="button"
                  aria-label={`Sweep this axis into ${String(sweepCount)} queued rolls`}
                  disabled={sweepCount === 0}
                  onClick={onSweepPrimary}
                >
                  <I.layers />
                  Sweep → queue {sweepCount}
                </button>
              ) : (
                <>
                  <button
                    className={buttons.secondary}
                    type="button"
                    aria-label="Simulate this prompt"
                    aria-busy={simulating}
                    disabled={simulating}
                    data-tip="Preview the final prompt here — resolves AI fills too. Doesn't fill the composer."
                    onClick={simulate}
                  >
                    {simulating ? 'Simulating…' : 'Simulate'}
                  </button>
                  <button
                    className={`${buttons.primary} ${styles.primaryControl}`}
                    type="button"
                    onClick={() => {
                      // Paste the template body with its grammar LIVE so the
                      // composer re-rolls ({{var::}}, {{random::}}, …) fresh on
                      // every Generate; only axes the user locked are baked into
                      // literal text (applyPinsToTemplateBody re-derives their
                      // occurrence keys against the macro-resolved shape the pins
                      // were keyed to, without freezing the macros themselves).
                      // No provenance either way: a live re-rolling prompt is not
                      // a faithfully-reproducible single roll, and setDraft({prompt})
                      // without provenance clears any stale value (atelier.ts).
                      const prompt = applyPinsToTemplateBody(
                        selectedTemplate.body,
                        data.variableLists,
                        { seed, pins: { ...draft.pins } },
                      );
                      // A library paste is a new brief: drop the Enhance anchor
                      // so Undo can't swap it for an earlier, unrelated prompt.
                      setDraft({ prompt, enhanceAnchor: undefined, enhancedText: undefined });
                      requestClose();
                    }}
                  >
                    Use prompt
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(
    <div ref={portalRootRef}>
      {isSheet ? (
        <>
          <button className={styles.backdrop} type="button" aria-label="Close templates" data-closing={closing ? 'true' : undefined} onClick={requestClose} />
          {panel}
        </>
      ) : panel}
      <ConfirmDialog
        open={pendingQueueClear !== null}
        title="Clear queued rolls?"
        body="Changing templates clears the current roll-queue."
        confirmLabel="Clear queue"
        cancelLabel="Keep queue"
        danger
        onConfirm={confirmQueueClear}
        onCancel={() => { setPendingQueueClear(null); }}
      />
      <ConfirmDialog
        open={pendingSweepConfirm}
        title={`Queue ${String(sweepCount)} rolls?`}
        body={`This fires ${String(sweepCount)} generations against your quota.`}
        confirmLabel="Queue rolls"
        cancelLabel="Cancel"
        onConfirm={() => { setPendingSweepConfirm(false); fireSweep(); }}
        onCancel={() => { setPendingSweepConfirm(false); }}
      />
    </div>,
    document.body,
  );
}
