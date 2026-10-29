import { useId, useState } from 'react';
import type { Ref } from 'react';
import { BRAINSTORM_DEFAULT_COUNT, BRAINSTORM_MIN_COUNT, BRAINSTORM_MAX_COUNT_CEILING } from '@atelier/shared';
import ChipSelect, { type ChipSelectOption } from '../Composer/ChipSelect';
import RollQueueList from '../RollQueueList';
import { useBrainstormCharacters } from '../../hooks/useBrainstormCharacters';
import { resolveComposerPrompt, type ComposerLibrary } from '../../lib/resolveComposerPrompt';
import { nextSeed } from '../../lib/seed';
import { useAtelierStore } from '../../store/atelier';
import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

export interface BrainstormPhaseProps {
  readonly onBack: () => void;
  readonly modelOptions: readonly ChipSelectOption<string>[];
  readonly modelId: string;
  readonly onModelChange: (value: string) => void;
  readonly modelMenuRef?: Ref<HTMLDivElement>;
  // Prompt-library data for resolving {{var::}} in the brief. Always present
  // here: PromptPicker (the only mount site) early-returns until it loads.
  readonly library: ComposerLibrary;
}

export default function BrainstormPhase({
  onBack,
  modelOptions,
  modelId,
  onModelChange,
  modelMenuRef,
  library,
}: BrainstormPhaseProps) {
  const briefId = useId();
  const countId = useId();
  // Brief/count live in the composer draft so they survive the picker closing
  // (same session-persistence as the composer prompt) instead of resetting on
  // unmount.
  const brief = useAtelierStore((s) => s.draft.brainstormBrief) ?? '';
  const count = useAtelierStore((s) => s.draft.brainstormCount) ?? BRAINSTORM_DEFAULT_COUNT;
  const setDraft = useAtelierStore((s) => s.setDraft);
  const setBrief = (value: string) => { setDraft({ brainstormBrief: value }); };
  const setCount = (value: number) => { setDraft({ brainstormCount: value }); };
  // Local text buffer for the number field so it can hold empty/intermediate
  // values while editing instead of snapping back to the default on every
  // keystroke. Clamping happens on commit (blur / Generate), not per-keystroke.
  const [countText, setCountText] = useState(() => String(count));
  const [syncedCount, setSyncedCount] = useState(count);
  if (count !== syncedCount) {
    // Store count changed externally (e.g. picker reopened): resync the buffer
    // via adjust-state-during-render, not an effect.
    setSyncedCount(count);
    setCountText(String(count));
  }
  const clampCount = (raw: string): number => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n)
      ? Math.min(Math.max(n, BRAINSTORM_MIN_COUNT), BRAINSTORM_MAX_COUNT_CEILING)
      : BRAINSTORM_DEFAULT_COUNT;
  };
  const commitCount = () => {
    const clamped = clampCount(countText);
    setCount(clamped);
    setCountText(String(clamped));
  };
  const rollQueue = useAtelierStore((s) => s.draft.rollQueue);
  const removeQueuedRoll = useAtelierStore((s) => s.removeQueuedRoll);
  const reorderQueuedRolls = useAtelierStore((s) => s.reorderQueuedRolls);
  const clearRollQueue = useAtelierStore((s) => s.clearRollQueue);
  const addToast = useAtelierStore((s) => s.addToast);
  const { status, generated, errorMessage, run, cancel } = useBrainstormCharacters();
  const running = status === 'running';
  const selectedModel = modelOptions.find((m) => m.value === modelId);

  // Resolve template grammar typed into the brief ({{var::}}, {{random::}}, …)
  // at Generate time with a fresh seed — the same engine the Composer runs — so
  // the brainstorm LLM receives finished text, not raw tokens. One resolution
  // per run: the resolved brief is pinned across all `count` characters, which
  // matches how the system prompt treats the brief as identical for every prompt.
  const handleGenerate = () => {
    const raw = brief.trim();
    let resolvedBrief = '';
    if (raw.length > 0) {
      const resolved = resolveComposerPrompt(raw, library, nextSeed());
      if (resolved.warnings.length > 0) {
        addToast(resolved.warnings[0] ?? 'Some brief tokens could not be resolved', 'soft');
      }
      resolvedBrief = resolved.text.trim();
      if (resolvedBrief.length === 0) {
        addToast('Brief resolved to empty — using default variety.', 'soft');
      }
    }
    // Commit any in-progress edit to the count buffer before generating, so a
    // typed-but-not-blurred value is honoured.
    const effectiveCount = clampCount(countText);
    if (effectiveCount !== count) setCount(effectiveCount);
    // Always normalise the visible buffer, even when the clamped value equals
    // the stored count (e.g. generating from a cleared field) — the
    // adjust-during-render resync only fires on a store change, so without this
    // the field could stay visually empty.
    setCountText(String(effectiveCount));
    void run({ ...(resolvedBrief ? { brief: resolvedBrief } : {}), count: effectiveCount, modelId });
  };

  return (
    <div className={styles.brainstormPhase}>
      <div className={styles.brainstormForm} data-zone="entry">
        <label htmlFor={briefId}>
          Brief <span className={styles.optional}>(optional)</span>
        </label>
        <textarea
          id={briefId}
          className={styles.brainstormBrief}
          placeholder="e.g. real world, 1950s to modern day; gritty, varied"
          value={brief}
          rows={3}
          disabled={running}
          onChange={(e) => { setBrief(e.target.value); }}
        />
        <div className={styles.brainstormControls}>
          <label htmlFor={countId}>Count</label>
          <input
            id={countId}
            type="number"
            min={BRAINSTORM_MIN_COUNT}
            max={BRAINSTORM_MAX_COUNT_CEILING}
            value={countText}
            disabled={running}
            onChange={(e) => { setCountText(e.target.value); }}
            onBlur={commitCount}
          />
          <ChipSelect<string>
            ariaLabel="Model"
            iconLeft={<I.chip />}
            valueDisplay={selectedModel?.label ?? modelId}
            valueTitle={selectedModel?.title ?? selectedModel?.label ?? modelId}
            options={modelOptions}
            value={modelId}
            disabled={running}
            {...(modelMenuRef ? { menuRootRef: modelMenuRef } : {})}
            onChange={onModelChange}
          />
        </div>
        {running ? (
          <p className={styles.hint} role="status" aria-live="polite">
            Generated {generated} of {count}
          </p>
        ) : null}
        {status === 'error' ? (
          <div className={styles.warnings} role="status">
            <p>{errorMessage ?? 'Brainstorm failed'}</p>
          </div>
        ) : null}
      </div>

      <div className={styles.scrollBody} data-zone="body">
        {rollQueue.length > 0 ? (
          <RollQueueList
            rolls={rollQueue}
            onRemove={removeQueuedRoll}
            onReorder={reorderQueuedRolls}
            onClear={clearRollQueue}
            variant="panel"
            ariaLabel="Brainstorm character queue"
          />
        ) : !running ? (
          <p className={styles.hint}>No characters yet — set a brief and generate.</p>
        ) : null}
        {running ? (
          <ul className={styles.skeletonList} aria-hidden="true" data-testid="brainstorm-skeletons">
            {Array.from({ length: Math.max(0, count - generated) }, (_, i) => (
              <li
                key={i}
                className={styles.skeletonRow}
                style={{ animationDelay: `${String(i * 40)}ms` }}
              />
            ))}
          </ul>
        ) : null}
      </div>

      <div className={styles.refineFoot} data-zone="foot">
        <div className={styles.footer}>
          {running ? (
            <button className={buttons.secondary} type="button" onClick={cancel}>Stop</button>
          ) : (
            <button className={buttons.secondary} type="button" onClick={onBack}>Back</button>
          )}
          <button
            className={buttons.ai}
            type="button"
            disabled={running || modelId.length === 0}
            onClick={handleGenerate}
          >
            <I.sparkle />
            {running ? 'Generating' : `Generate ${String(count)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
