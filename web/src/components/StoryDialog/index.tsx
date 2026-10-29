import {
  STORY_OUTLINE_MAX_CHARS,
  videoDurationSeconds,
  type Ratio,
  type StorySegmentPlan,
} from '@atelier/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { historyKeys } from '../../api/history';
import { tellStoryStream, type TellStoryRequest } from '../../api/stories';
import { useAbortableMutation } from '../../hooks/useAbortableMutation';
import { useExitTransition } from '../../hooks/useExitTransition';
import { describeError } from '../../lib/errorCopy';
import { runWhenReachable } from '../../lib/focus';
import { useAtelierStore } from '../../store/atelier';
import buttons from '../../styles/buttons.module.css';
import dialogStyles from '../../styles/dialog.module.css';
import { DialogShell } from '../DialogShell';
import styles from './index.module.css';

export interface StoryDialogSource {
  readonly mode: 't2v' | 'i2v' | 'extend';
  readonly sourceUploadId?: string;
  readonly extendsTileId?: string;
  readonly sourcePrompt?: string;
  readonly ratio: Ratio;
}

interface AnnouncedPlan {
  readonly storyId: string;
  readonly logline: string;
  readonly segments: readonly StorySegmentPlan[];
  readonly etaMs: number;
}

interface StoryDialogProps {
  readonly source: StoryDialogSource;
  readonly onClose: () => void;
  readonly stream?: typeof tellStoryStream;
}

function sourceLine(mode: StoryDialogSource['mode']): string {
  if (mode === 'i2v') return 'From this image';
  if (mode === 'extend') return 'Continuing this video';
  return 'From scratch';
}

export default function StoryDialog({ source, onClose, stream = tellStoryStream }: StoryDialogProps) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const sourceId = useId();
  const outlineId = useId();
  const errorId = useId();
  const outlineRef = useRef<HTMLTextAreaElement | null>(null);
  const planRequest = useAbortableMutation();
  const outline = useAtelierStore((state) => state.draft.storyOutline) ?? '';
  const setDraft = useAtelierStore((state) => state.setDraft);
  const setPendingStory = useAtelierStore((state) => state.setPendingStory);
  const [state, setState] = useState<'idle' | 'planning' | 'announced'>('idle');
  const [plan, setPlan] = useState<AnnouncedPlan | null>(null);
  // Planning failures render inline, beside the outline they are about. The
  // dialog owns this feedback: a toast alone would land on (or announce from)
  // a surface the modal hides, and both together would announce twice.
  const [planError, setPlanError] = useState<string | null>(null);
  const { closing, requestClose } = useExitTransition(onClose, true);

  useEffect(() => {
    const target = outlineRef.current;
    runWhenReachable(() => { target?.focus(); }, target);
  }, []);

  const close = () => {
    planRequest.abort('story dialog closed');
    requestClose();
  };

  const submit = async () => {
    const trimmed = outline.trim();
    // A dismissed dialog stays focusable through its exit fade; Escape then
    // Cmd/Ctrl+Enter must not start a plan that the server would persist.
    if (closing || trimmed.length === 0 || state !== 'idle') return;
    const signal = planRequest.supersede();
    setPlanError(null);
    setState('planning');
    const request: TellStoryRequest = {
      outline: trimmed,
      ratio: source.ratio,
      ...(source.sourceUploadId ? { sourceUploadId: source.sourceUploadId } : {}),
      ...(source.extendsTileId ? { extendsTileId: source.extendsTileId } : {}),
      ...(source.sourcePrompt ? { sourcePrompt: source.sourcePrompt } : {}),
    };
    try {
      let announced = false;
      for await (const event of stream(request, signal)) {
        if (event.event === 'status') continue;
        if (event.event === 'error') {
          setPlanError(event.data.message);
          setState('idle');
          return;
        }
        announced = true;
        setPlan(event.data);
        setState('announced');
        setPendingStory({ id: event.data.storyId, until: Date.now() + 5 * 60_000 });
        void queryClient.invalidateQueries({ queryKey: historyKeys.all() });
        break;
      }
      if (!announced && !signal.aborted) throw new Error("Couldn't plan the story. Please try again.");
    } catch (error) {
      if (signal.aborted) return;
      setPlanError(describeError(error, "Couldn't plan the story. Please try again."));
      setState('idle');
    }
  };

  const canSubmit = outline.trim().length > 0 && state === 'idle';

  return (
    <DialogShell
      open
      onCancel={close}
      closing={closing}
      labelledBy={titleId}
      describedBy={sourceId}
    >
      <div className={`${dialogStyles.dialog} ${styles.dialog}`}>
        <div className={dialogStyles.handle} aria-hidden="true" />
        <h2 id={titleId} className={dialogStyles.title}>Tell Story</h2>
        <p id={sourceId} className={styles.source}>{sourceLine(source.mode)}</p>

        {state !== 'announced' ? (
          <>
            <label className={styles.label} htmlFor={outlineId}>Story outline</label>
            <textarea
              ref={outlineRef}
              id={outlineId}
              className={styles.outline}
              value={outline}
              maxLength={STORY_OUTLINE_MAX_CHARS}
              disabled={state === 'planning'}
              aria-describedby={planError ? errorId : undefined}
              placeholder="Describe the story, its turning point, and how it should end…"
              onChange={(event) => { setDraft({ storyOutline: event.target.value }); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {planError ? (
              <p id={errorId} className={dialogStyles.inlineError} role="alert">{planError}</p>
            ) : null}
            <div className={styles.actions}>
              <button type="button" className={buttons.secondary} onClick={close}>Cancel</button>
              <button
                type="button"
                className={buttons.primary}
                disabled={!canSubmit}
                aria-busy={state === 'planning' || undefined}
                onClick={() => { void submit(); }}
              >
                {state === 'planning' ? (
                  <><span className={styles.spinner} aria-hidden="true" />Planning your story…</>
                ) : 'Tell Story'}
              </button>
            </div>
          </>
        ) : plan ? (
          <div className={styles.announcement} aria-live="polite">
            <p className={styles.logline}>{plan.logline}</p>
            <ol className={styles.segments}>
              {plan.segments.map((segment, index) => (
                <li key={`${String(index)}-${segment.beat}`}>
                  <span>{segment.beat}</span>
                  <span className={styles.duration}>≈{Math.round(videoDurationSeconds(segment.durationFrames))} sec</span>
                </li>
              ))}
            </ol>
            <div className={styles.summary}>
              <span>{plan.segments.length} segments</span>
              <span>≈{Math.max(1, Math.ceil(plan.etaMs / 60_000))} min total</span>
            </div>
            <div className={styles.actions}>
              <button type="button" className={buttons.primary} onClick={close}>Done</button>
            </div>
          </div>
        ) : null}

        {state === 'planning' && <div className={dialogStyles.progressBar} aria-hidden="true" />}
      </div>
    </DialogShell>
  );
}
