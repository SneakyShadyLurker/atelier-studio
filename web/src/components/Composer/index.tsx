import { MAX_TILE_COUNT, VAR_TOKEN_PATTERN } from '@atelier/shared';
import type { Model, Ratio } from '@atelier/shared';
import { AI_FILL_MAX_SLOTS, hasAiFillTokens, parseAiFillTokens } from '@atelier/shared/ai-fill';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { textModelsOpts } from '../../api/textModels';
import { refImageUrl, uploadRefImage } from '../../api/uploads';
import { beginSourceHandoff, supersedeSourceHandoffs } from '../../lib/composerSourceHandoff';
import { I2V_ESTIMATED_LABEL } from '../../lib/i2v';
import { isImeComposing } from '../../lib/ime';
import { promptPickerAvailable } from '../../lib/modelSelection';
import { describeError } from '../../lib/errorCopy';
import { runWhenReachable } from '../../lib/focus';
import { useDeleteUpload } from '../../hooks/useDeleteUpload';
import { useAttachRefImages } from '../../hooks/useAttachRefImages';
import { useComposerViewportInsets } from '../../hooks/useComposerViewportInsets';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useEnhancePrompt } from '../../hooks/useEnhancePrompt';
import { useProbeModel } from '../../hooks/useProbeModel';
import { useKeyboardScopeActive, useKeyboardScoped } from '../../hooks/useKeyboard';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import type { Count, RefImageDraft } from '../../store/atelier';
import { canSubmitDraft, holdUploadsForUndo, MAX_REF_IMAGES_FALLBACK, useAtelierStore } from '../../store/atelier';
import { I } from '../icons/I';
import ChipSelect, { type ChipSelectOption } from './ChipSelect';
import { CollapsedBar } from './CollapsedBar';
import EnhanceControl from './EnhanceControl';
import InFlightIndicator from './InFlightIndicator';
import { hostLabel, shortModelToken } from './modelToken';
import PromptPicker from '../PromptPicker';
import RatioChip from './RatioChip';
import DurationChip from './DurationChip';
import type { VideoDurationFrames } from '@atelier/shared';
import { ACCEPTED_REF_ACCEPT, RefImageRow } from './RefImageRow';
import RollQueueList from '../RollQueueList';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

export const COMPOSER_PROMPT_ID = 'atelier-composer-prompt';
const BYOK_SENTINEL = '__BYOK__';
const HOST_STATUS_WORDS = { online: 'Online', offline: 'Offline' } as const;

function countLiveTokens(value: string): number {
  const variablePattern = new RegExp(VAR_TOKEN_PATTERN, 'g');
  const variables = value.match(variablePattern)?.length ?? 0;
  let remaining = value.replace(variablePattern, '');
  let macros = 0;
  const leafMacroPattern = /\{\{[^{}]+\}\}/g;
  let matches = remaining.match(leafMacroPattern);
  while (matches !== null) {
    macros += matches.length;
    remaining = remaining.replace(leafMacroPattern, '');
    matches = remaining.match(leafMacroPattern);
  }
  return variables + macros;
}

function formatCheckedAgo(checkedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - checkedAt) / 1000));
  if (seconds < 60) return `checked ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `checked ${minutes}m ago`;
}

const counts: readonly ChipSelectOption<Count>[] = Array.from(
  { length: MAX_TILE_COUNT },
  (_, index): ChipSelectOption<Count> => {
    // index+1 is bounded 1..MAX_TILE_COUNT; the _countMaxLock in the store
    // guarantees that range is a subset of Count.
    const value = (index + 1) as Count;
    return { value, label: `${value} image${value === 1 ? '' : 's'}` };
  },
);

interface ComposerProps {
  models: readonly Model[];
  modelById: ReadonlyMap<string, Model>;
  prompt: string;
  modelId: string;
  ratio: Ratio;
  count: Count;
  disabled?: boolean;
  /** Concurrency cap; the indicator turns danger-toned at the cap. */
  inFlightCap?: number;
  promptsEnabled?: boolean;
  error?: string | null;
  onPromptChange: (prompt: string) => void;
  onModelChange: (modelId: string) => void;
  onRatioChange: (ratio: Ratio) => void;
  /** Present only when the selected model is a video row; drives the chip's visibility. */
  durationFrames?: VideoDurationFrames | undefined;
  onDurationChange: (frames: VideoDurationFrames) => void;
  onCountChange: (count: Count) => void;
  onSubmit: () => void;
  onTellStory?: (() => void) | undefined;
  onStopDraining?: () => void;
  retryingPrepared?: boolean;
  onRetryModels?: () => void;
}

function Composer({
  models,
  modelById,
  prompt,
  modelId,
  ratio,
  count,
  disabled = false,
  inFlightCap = 0,
  promptsEnabled = false,
  error = null,
  onPromptChange,
  onModelChange,
  onRatioChange,
  durationFrames,
  onDurationChange,
  onCountChange,
  onSubmit,
  onTellStory,
  onStopDraining = () => undefined,
  retryingPrepared = false,
  onRetryModels,
}: ComposerProps) {
  const isPhone = useIsPhone();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const motionRef = useRef<HTMLTextAreaElement | null>(null);
  const sourceUploadRef = useRef<HTMLInputElement | null>(null);
  const collapsedExpandRef = useRef<HTMLButtonElement | null>(null);
  const motionPromptId = useId();
  const statusId = useId();
  const [dragActive, setDragActive] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const pointerInsideRef = useRef(false);
  const [sourceUploading, setSourceUploading] = useState(false);
  const [probingModelId, setProbingModelId] = useState<string | null>(null);
  const modelIntentRef = useRef(0);
  const activeModelIdRef = useRef(modelId);
  const previousModelIdRef = useRef(modelId);
  const probePromisesRef = useRef(new Map<string, Promise<readonly Model[]>>());
  const promptPickerOpen = useAtelierStore((state) => state.pickerOpen);
  const openPicker = useAtelierStore((state) => state.openPicker);
  const closePicker = useAtelierStore((state) => state.closePicker);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const rollQueue = useAtelierStore((state) => state.draft.rollQueue);
  const resolving = useAtelierStore((state) => state.resolving);
  const preparing = useAtelierStore((state) => state.preparing);
  const aiFillActive = useAtelierStore((state) => state.aiFillActive);
  const aiFillLabels = useAtelierStore((state) => state.aiFillLabels);
  // Fallback names for the in-flight pill when a frame carried no label; only
  // fetched while a fill is running.
  const { data: textModels } = useQuery({
    ...textModelsOpts(),
    enabled: Object.keys(aiFillActive).length > 0,
    select: (data) => data.models,
  });
  const aiFillLabelById = useMemo(() => {
    const labels = new Map(textModels?.map((model) => [model.id, model.displayName]));
    for (const [modelId, label] of Object.entries(aiFillLabels)) labels.set(modelId, label);
    return labels;
  }, [textModels, aiFillLabels]);
  const draining = useAtelierStore((state) => state.draining);
  const canStop = draining || retryingPrepared;
  const removeQueuedRoll = useAtelierStore((state) => state.removeQueuedRoll);
  const reorderQueuedRolls = useAtelierStore((state) => state.reorderQueuedRolls);
  const clearRollQueue = useAtelierStore((state) => state.clearRollQueue);
  const refImages = useAtelierStore((state) => state.draft.refImages);
  const i2vSourceUploadId = useAtelierStore((state) => state.draft.i2vSourceUploadId);
  const i2vSourcePrompt = useAtelierStore((state) => state.draft.i2vSourcePrompt);
  const motionPrompt = useAtelierStore((state) => state.draft.motionPrompt);
  const extendsTileId = useAtelierStore((state) => state.draft.extendsTileId);
  const extendPrevPrompt = useAtelierStore((state) => state.draft.extendPrevPrompt);
  const lastImageModelId = useAtelierStore((state) => state.draft.lastImageModelId);
  const removeRefImage = useAtelierStore((state) => state.removeRefImage);
  const setDraft = useAtelierStore((state) => state.setDraft);
  const addToast = useAtelierStore((state) => state.addToast);
  const readyRefImageIds = useMemo(
    () => refImages.flatMap((ref) => (ref.status === 'ready' && ref.serverId ? [ref.serverId] : [])),
    [refImages],
  );
  const composerExpanded = useAtelierStore((state) => state.composerExpanded);
  const composerMinimized = useAtelierStore((state) => state.composerMinimized);
  const setComposerMinimized = useAtelierStore((state) => state.setComposerMinimized);
  const previousComposerExpanded = useRef(composerExpanded);
  const setComposerExpanded = useAtelierStore((state) => state.setComposerExpanded);
  const attachRefImages = useAttachRefImages();
  const deleteUpload = useDeleteUpload();
  const probeMutation = useProbeModel();
  const { enhance, undo, editPrompt, status: enhanceStatus, canUndo } = useEnhancePrompt({ prompt, refImageIds: readyRefImageIds, modelId, ratio, onPromptChange });
  const enhancing = enhanceStatus === 'streaming';
  useLayoutEffect(() => {
    activeModelIdRef.current = modelId;
  }, [modelId]);
  useEffect(() => {
    if (previousModelIdRef.current === modelId) return;
    previousModelIdRef.current = modelId;
    modelIntentRef.current += 1;
    setProbingModelId(null);
  }, [modelId]);
  useEffect(() => () => {
    modelIntentRef.current += 1;
    probePromisesRef.current.clear();
  }, []);
  const selectedModel = modelById.get(modelId) ?? models[0];
  // Serving host's live health, driving the chip dot + hover title.
  // Undefined (no availability payload) renders no dot rather than a guess.
  const localHostStatus = selectedModel?.backend === 'local' && selectedModel.availability
    ? (selectedModel.availability.ok ? 'online' : 'offline')
    : undefined;
  const isI2VMode = selectedModel?.supportsI2V === true;
  const isExtendMode = isI2VMode && extendsTileId !== undefined;
  // The model to drop back to when leaving animate mode: the last image model
  // the user was on, falling back to the first available image model. Switching
  // to it is what exits video mode (handleModelChange clears the I2V draft).
  const exitToImageModelId = useMemo(() => {
    // Exclude BOTH video flags: outputsVideo is the canonical marker, but a
    // stale cached model list from before the flag existed only carries
    // supportsI2V — never exit video mode into another video model.
    const isImageModel = (model: Model): boolean =>
      model.outputsVideo !== true && model.supportsI2V !== true;
    const remembered = lastImageModelId ? modelById.get(lastImageModelId) : undefined;
    if (remembered && isImageModel(remembered)) return remembered.id;
    for (const model of modelById.values()) {
      if (isImageModel(model)) return model.id;
    }
    return undefined;
  }, [lastImageModelId, modelById]);
  // Local-pool models share a server-wide cap of 1 tile (single GPU host).
  // Lock the count chip to 1 + visually communicate it so the user doesn't
  // submit a batch of 4 and hit a 429. The pool predicate (not `backend`)
  // is intentional: a mock model with `backend:'local'` is `pool:'shared'`.
  const isLocalPool = selectedModel?.pool === 'local';
  const maxCountPerBatch = isI2VMode
    ? 1
    : Math.min(selectedModel?.maxCountPerBatch ?? MAX_TILE_COUNT, MAX_TILE_COUNT);
  const countLocked = maxCountPerBatch <= 1;
  const visibleCount = Math.min(count, maxCountPerBatch) as Count;
  const maxRefImages = selectedModel?.maxRefImages ?? MAX_REF_IMAGES_FALLBACK;
  const maxRefBytesPerBatch = selectedModel?.maxRefBytesPerBatch;
  const hasRefs = refImages.length > 0;
  const hasUploadingRefs = refImages.some((ref) => ref.status === 'uploading');
  const hasErrorRefs = refImages.some((ref) => ref.status === 'error');
  const refsUnsupported = hasRefs && selectedModel?.supportsReferenceImages !== true;
  const draftSubmittable = canSubmitDraft({ refImages, i2vSourceUploadId, motionPrompt }, selectedModel);
  const refsOverCap = hasRefs && refImages.length > maxRefImages;
  const missingI2VSource = isI2VMode && !i2vSourceUploadId;
  // The motion prompt is the H3 workflow's only text conditioning, so it is
  // required to animate (and becomes the wire prompt; see toGenerateRequest).
  const missingMotion = isI2VMode && !(motionPrompt?.trim());
  const selectedModelOffline = selectedModel?.availability?.ok === false;
  const promptHasContent = prompt.trim().length > 0;
  // In I2V mode the generic prompt is hidden and ignored by the video workflow —
  // a present source still is what makes the batch submittable (motion prompt is
  // optional). Otherwise the usual prompt-or-queued rule applies.
  const hasSubmittableInput = isI2VMode ? Boolean(i2vSourceUploadId) : (promptHasContent || rollQueue.length > 0);
  // "Nothing in the composer" for desktop auto-minimize — mode-aware, since the
  // video draft lives in motionPrompt + the source still, not prompt/refs.
  const composerHasContent = isI2VMode
    ? (motionPrompt ?? '').trim().length > 0 || Boolean(i2vSourceUploadId) || sourceUploading
    : promptHasContent || refImages.length > 0;
  // {{ai-fill}} blanks are capped per prompt (the server hard-rejects more than
  // AI_FILL_MAX_SLOTS with a 400, which would silently drop the prompt at submit).
  // Count them live so we can block + explain before the user fires it. The
  // hidden-prompt I2V mode never fires ai-fill, so leftover tokens can't block it.
  const aiFillCount = hasAiFillTokens(prompt) ? parseAiFillTokens(prompt).slots.length : 0;
  const aiFillExceeded = !isI2VMode && aiFillCount > AI_FILL_MAX_SLOTS;
  const generateDisabled = disabled || enhancing || !hasSubmittableInput || hasUploadingRefs
    || hasErrorRefs || refsUnsupported || !draftSubmittable || refsOverCap || selectedModelOffline || aiFillExceeded
    || sourceUploading || missingI2VSource || missingMotion;
  const canSubmitNow = !generateDisabled;
  const totalToFire = rollQueue.length + (promptHasContent ? 1 : 0);
  const generateBaseLabel = isExtendMode ? 'Extend' : isI2VMode ? 'Animate' : 'Generate';
  const showRollCount = !isI2VMode && rollQueue.length > 0;
  const targetModelName = selectedModel?.name ?? 'selected model';
  const targetContextLine = `Will run on ${targetModelName} · ${ratio} · ×${String(visibleCount)} · ${String(refImages.length)} ref${refImages.length === 1 ? '' : 's'}`;
  const modelOptions = useMemo<readonly ChipSelectOption<string>[]>(() => {
    const local = models.filter((model) => model.backend === 'local');
    const cloud = models.filter((model) => model.backend === 'cloud');
    const toOption = (model: Model): ChipSelectOption<string> => {
      const offline = model.availability && !model.availability.ok;
      // Two disabled states, two different hint labels. `Key required` is the
      // existing UX for BYOK without a configured key — clicking opens the
      // key manager. `Offline` is the new one — server's health probe says
      // the upstream host is unreachable; clicking starts an on-demand probe
      // in handleModelChange below.
      // Local models advertise their host tag (`comfyui`); cloud models
      // keep their free-form locator tag (e.g. `google`).
      const locator = model.backend === 'local' ? hostLabel(model.tag) : model.tag;
      let hint: string;
      if (model.requiresKey) hint = 'Key required';
      else if (probingModelId === model.id) hint = 'Checking…';
      else if (offline) hint = 'Offline · Check again';
      else hint = locator;
      const baseTitle = `${model.backend} · ${locator} · ${model.latency}`;
      const title = offline && model.availability
        ? `${baseTitle} — host offline (${formatCheckedAgo(model.availability.checkedAt)})`
        : baseTitle;
      return {
        value: model.id,
        label: model.name,
        hint,
        group: model.backend === 'local' ? 'Local' : 'Cloud',
        title,
        disabled: model.requiresKey !== undefined,
        actionable: model.requiresKey === undefined && offline === true,
        keepOpenOnSelect: model.requiresKey === undefined && offline === true,
      };
    };
    return [
      ...local.map(toOption),
      ...cloud.map(toOption),
      {
        value: BYOK_SENTINEL,
        label: 'Manage API keys…',
        group: '__byok__',
        groupLabel: '',
      },
    ];
  }, [models, probingModelId]);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    if (typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content')) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [prompt, composerExpanded, composerMinimized]);

  useComposerViewportInsets(wrapRef);

  const noModels = models.length === 0;
  const forceExpanded = error != null;
  const collapsed = (isPhone ? !composerExpanded : composerMinimized) && !forceExpanded;
  const minimize = () => {
    setComposerMinimized(true);
    runWhenReachable(() => { collapsedExpandRef.current?.focus(); }, wrapRef.current);
  };
  useFocusTrap(wrapRef, {
    active: isPhone && composerExpanded,
    returnFocusTo: collapsedExpandRef,
    autoFocus: false,
  });
  const composerKeyboardActive = isPhone ? composerExpanded : composerFocused && !collapsed;
  // A pointer landing in the feed while the composer holds nothing is the
  // operator moving on. On a fresh load the wrap never had focus, so the blur
  // path alone would leave the empty composer covering the canvas until the
  // first keystroke. Open composer-owned popovers and dialogs are not "outside".
  useOutsidePointer([wrapRef], () => {
    const wrap = wrapRef.current;
    // Only popover triggers count (ChipSelect, Templates): a persistent
    // disclosure such as the roll-queue expander must not pin the composer open.
    if (!wrap || wrap.querySelector('[aria-haspopup][aria-expanded="true"]')) return;
    const active = document.activeElement;
    if (active instanceof Element && active.closest('dialog, [role="dialog"], [role="listbox"], [role="menu"]')) return;
    setComposerMinimized(true);
  }, { enabled: !isPhone && !collapsed && !forceExpanded && !composerHasContent });
  useKeyboardScopeActive('composer', composerKeyboardActive);
  useKeyboardScoped('composer', 'Escape', (event) => {
    // Escape during IME composition dismisses the candidate window, not us.
    if (event.defaultPrevented || isImeComposing(event)) return;
    if (!isPhone && !wrapRef.current?.contains(document.activeElement)) {
      // Focus left without a blur we saw (a focused control unmounted); drop
      // the scope so the next Escape reaches whoever owns it.
      setComposerFocused(false);
      return;
    }
    event.preventDefault();
    if (isPhone) setComposerExpanded(false);
    else minimize();
  }, composerKeyboardActive);
  // Keep the desktop keyboard scope tied to where focus actually is: a focused
  // control that unmounts moves focus to <body> with no focusout on the wrap.
  useEffect(() => {
    if (isPhone) return;
    const onFocusIn = (event: FocusEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      setComposerFocused(event.target instanceof Node && wrap.contains(event.target));
    };
    document.addEventListener('focusin', onFocusIn);
    return () => { document.removeEventListener('focusin', onFocusIn); };
  }, [isPhone]);

  // Phone only: focus the textarea on expand and always restore the newly
  // mounted collapsed-bar control after an expanded→collapsed transition.
  // This covers every dismissal path, including App's scrim and Canvas's
  // scroll-collapse, whose callers do not have access to this local ref.
  useEffect(() => {
    if (!isPhone) {
      previousComposerExpanded.current = composerExpanded;
      return;
    }
    if (composerExpanded && !previousComposerExpanded.current) {
      const target = isI2VMode ? motionRef.current : textRef.current;
      runWhenReachable(() => { target?.focus(); }, target);
    } else if (!composerExpanded && previousComposerExpanded.current) {
      collapsedExpandRef.current?.focus();
    }
    previousComposerExpanded.current = composerExpanded;
  }, [composerExpanded, isPhone, isI2VMode]);

  if (noModels) {
    return (
      <div ref={wrapRef} className={styles.wrap} id="atelier-composer">
        <div className={styles.composer}>
          <div className={styles.banner}>
            <span>{error ?? 'Models unavailable'}</span>
            <button type="button" className={styles.bannerAction} aria-label="Retry loading models" onClick={onRetryModels}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedModel) return null;

  const submit = () => {
    if (retryingPrepared) return;
    if (selectedModel.requiresKey) {
      useAtelierStore.getState().openByok();
      return;
    }
    if (selectedModel.availability && !selectedModel.availability.ok) {
      addToast(`${selectedModel.name} is offline`, 'error');
      return;
    }
    if (generateDisabled) return;
    onSubmit();
  };

  const collapseWithFocusReturn = () => {
    setComposerExpanded(false);
  };

  const handleModelChangeAsync = async (next: string) => {
    const intent = modelIntentRef.current + 1;
    modelIntentRef.current = intent;
    const modelIdAtStart = activeModelIdRef.current;
    setProbingModelId(null);
    if (next === BYOK_SENTINEL) {
      useAtelierStore.getState().openByok();
      return;
    }
    const candidate = modelById.get(next);
    if (candidate?.requiresKey) {
      useAtelierStore.getState().openByok();
      return;
    }
    // A deliberate model pick is the newest source intent: a tile handoff
    // still in flight must not switch the model or video draft back.
    if (next !== modelIdAtStart) supersedeSourceHandoffs();
    if (candidate?.availability && !candidate.availability.ok) {
      // ChipSelect renders the option with `aria-disabled` + a styles hook,
      // but its click / keyboard-Enter handlers do NOT gate on `disabled`
      // (mirrors the BYOK gate: clicking "Key required" opens the BYOK pane
      // by design). The actual gate lives here and turns the click into an
      // immediate health re-check before deciding whether to select.
      setProbingModelId(candidate.id);
      let probePromise = probePromisesRef.current.get(candidate.id);
      if (probePromise === undefined) {
        addToast(`Re-checking ${candidate.name}…`, 'soft');
        probePromise = probeMutation.mutateAsync(candidate.id);
        probePromisesRef.current.set(candidate.id, probePromise);
        const ownedPromise = probePromise;
        void ownedPromise.then(
          () => {
            if (probePromisesRef.current.get(candidate.id) === ownedPromise) {
              probePromisesRef.current.delete(candidate.id);
            }
          },
          () => {
            if (probePromisesRef.current.get(candidate.id) === ownedPromise) {
              probePromisesRef.current.delete(candidate.id);
            }
          },
        );
      }
      try {
        const refreshedModels = await probePromise;
        if (modelIntentRef.current !== intent || activeModelIdRef.current !== modelIdAtStart) return;
        const refreshed = refreshedModels.find((model) => model.id === candidate.id);
        if (!refreshed || refreshed.availability?.ok === false) {
          addToast(`${candidate.name} is offline`, 'error');
          return;
        }
        onModelChange(next);
      } catch (error) {
        if (modelIntentRef.current !== intent || activeModelIdRef.current !== modelIdAtStart) return;
        const reason = describeError(error, 'request failed');
        addToast(`Couldn't re-check ${candidate.name} — ${reason}`, 'error');
      } finally {
        if (modelIntentRef.current === intent && activeModelIdRef.current === modelIdAtStart) {
          setProbingModelId(null);
        }
      }
      return;
    }
    // onModelChange owns the draft patch, including video-state cleanup.
    onModelChange(next);
  };

  const handleModelChange = (next: string): void => {
    void handleModelChangeAsync(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !isImeComposing(event)) {
      event.preventDefault();
      submit();
    }
  };

  const enqueueFiles = (files: readonly File[]) => {
    attachRefImages(files, { mode: 'append', capacity: maxRefImages, maxRefBytesPerBatch }).catch(() => undefined);
  };

  const uploadSourceStill = async (files: readonly File[]) => {
    const file = files[0];
    if (!file || sourceUploading) return;
    // Keep any existing source visible while the replacement uploads (a spinner
    // overlays the thumb); only swap the id once the new upload resolves, so a
    // failed replace leaves the prior still intact.
    setSourceUploading(true);
    // A manual source supersedes any tile handoff still in flight, and a tile
    // handoff started during this upload supersedes it in turn.
    const isCurrent = beginSourceHandoff();
    try {
      const upload = await uploadRefImage(file);
      if (!isCurrent()) return;
      // A manually-uploaded still has no known generation prompt — clear any
      // i2vSourcePrompt carried over from a prior Animate so the motion enhancer
      // never anchors this still to a different subject's prompt.
      setDraft({
        i2vSourceUploadId: upload.id,
        i2vSourcePrompt: undefined,
        extendsTileId: undefined,
        extendPrevPrompt: undefined,
      });
    } catch {
      if (isCurrent()) addToast('Source still upload failed', 'error');
    } finally {
      setSourceUploading(false);
    }
  };

  const clearSourceStill = () => {
    if (sourceUploading) return;
    supersedeSourceHandoffs();
    setDraft({
      i2vSourceUploadId: undefined,
      i2vSourcePrompt: undefined,
      extendsTileId: undefined,
      extendPrevPrompt: undefined,
    });
  };

  const countOptions = counts.map((option) => (
    option.value > maxCountPerBatch
      ? { ...option, disabled: true, hint: `Max ${String(maxCountPerBatch)}` }
      : option
  ));

  const handleCountChange = (next: Count) => {
    if (next > maxCountPerBatch) {
      addToast(`This model can start at most ${String(maxCountPerBatch)} image${maxCountPerBatch === 1 ? '' : 's'} per batch`, 'soft');
      return;
    }
    onCountChange(next);
  };

  const removeRef = (ref: RefImageDraft) => {
    if (ref.status === 'uploading') return;
    if (!ref.serverId) {
      removeRefImage(ref.clientId);
      return;
    }
    deleteUpload.mutate(ref.serverId, {
      onSuccess: (result) => {
        if (!result.referenced) removeRefImage(ref.clientId);
      },
    });
  };

  // Clear is gated while an upload is in flight (matching removeRef's guard):
  // an uploading ref has no serverId yet, so the deferred teardown could not
  // delete the server artifact, and an Undo would restore a chip stuck in
  // 'uploading' forever (its success event fired against the cleared draft).
  const canClear = (prompt.length > 0 || hasRefs || Boolean(i2vSourceUploadId) || Boolean(motionPrompt)) && !hasUploadingRefs && !sourceUploading;
  const clearAll = () => {
    if (!canClear) return;
    // Mirror the roll-queue clear: snapshot + Undo toast. Destructive teardown
    // (server upload deletes, blob-preview revocation) rides the toast's
    // onDismiss — NOT a parallel wall-clock timer — so pause-on-hover/focus
    // (WCAG) defers teardown along with the Undo affordance and a restore
    // always gets live previews and valid serverIds.
    const { enhanceAnchor, enhancedText } = useAtelierStore.getState().draft;
    const snapshot = { prompt, refImages, i2vSourceUploadId, i2vSourcePrompt, motionPrompt, extendsTileId, extendPrevPrompt, enhanceAnchor, enhancedText };
    const releaseUndoHold = holdUploadsForUndo([
      ...refImages.flatMap((ref) => (ref.serverId ? [ref.serverId] : [])),
      ...(i2vSourceUploadId ? [i2vSourceUploadId] : []),
    ]);
    let undone = false;
    supersedeSourceHandoffs();
    // Clear is the ONLY place the Enhance anchor is dropped (see useEnhancePrompt).
    setDraft({
      prompt: '',
      refImages: [],
      i2vSourceUploadId: undefined,
      i2vSourcePrompt: undefined,
      motionPrompt: undefined,
      extendsTileId: undefined,
      extendPrevPrompt: undefined,
      enhanceAnchor: undefined,
      enhancedText: undefined,
    });
    addToast('Composer cleared', 'soft', 5000, {
      label: 'Undo',
      onClick: () => {
        undone = true;
        releaseUndoHold();
        supersedeSourceHandoffs();
        setDraft({
          prompt: snapshot.prompt,
          refImages: snapshot.refImages,
          i2vSourceUploadId: snapshot.i2vSourceUploadId,
          i2vSourcePrompt: snapshot.i2vSourcePrompt,
          motionPrompt: snapshot.motionPrompt,
          extendsTileId: snapshot.extendsTileId,
          extendPrevPrompt: snapshot.extendPrevPrompt,
          enhanceAnchor: snapshot.enhanceAnchor,
          enhancedText: snapshot.enhancedText,
        });
      },
    }, () => {
      releaseUndoHold();
      if (undone) return;
      for (const ref of snapshot.refImages) {
        if (ref.previewUrl.startsWith('blob:')) URL.revokeObjectURL(ref.previewUrl);
        if (ref.serverId) deleteUpload.mutate(ref.serverId);
      }
    });
  };

  let statusMessage = '';
  let statusTone: 'danger' | 'info' = 'info';
  if (disabled) {
    statusMessage = 'Generation unavailable';
    statusTone = 'danger';
  } else if (enhancing) {
    statusMessage = 'Enhancing prompt';
  } else if (selectedModelOffline) {
    statusMessage = `${selectedModel.name} is offline`;
    statusTone = 'danger';
  } else if (!hasSubmittableInput) {
    statusMessage = isI2VMode ? 'Add source still' : 'Write a prompt or queue a roll';
    statusTone = 'info';
  } else if (hasUploadingRefs) {
    statusMessage = 'Uploading references';
  } else if (refsUnsupported) {
    statusMessage = 'Model does not accept refs';
    statusTone = 'danger';
  } else if (refsOverCap) {
    statusMessage = `This model accepts at most ${maxRefImages} ${maxRefImages === 1 ? 'ref' : 'refs'}`;
    statusTone = 'danger';
  } else if (hasErrorRefs) {
    statusMessage = 'Remove failed refs';
    statusTone = 'danger';
  } else if (aiFillExceeded) {
    statusMessage = `${aiFillCount} AI fills · max ${AI_FILL_MAX_SLOTS}`;
    statusTone = 'danger';
  } else if (missingI2VSource) {
    statusMessage = 'Add source still';
    statusTone = 'info';
  } else if (sourceUploading) {
    statusMessage = 'Uploading source still';
    statusTone = 'info';
  } else if (missingMotion) {
    statusMessage = 'Describe the motion to animate';
    statusTone = 'info';
  } else if (isExtendMode) {
    statusMessage = `Sequence handoff ready · ${I2V_ESTIMATED_LABEL} render`;
    statusTone = 'info';
  } else if (countLocked) {
    statusMessage = isI2VMode ? `One clip · ${I2V_ESTIMATED_LABEL} render` : (isLocalPool ? 'One tile at a time' : 'One image per batch');
    statusTone = 'info';
  } else if (maxCountPerBatch < MAX_TILE_COUNT) {
    statusMessage = `Max ${String(maxCountPerBatch)} images per batch`;
    statusTone = 'info';
  }
  const liveTokenCount = isI2VMode ? 0 : countLiveTokens(prompt);
  if (liveTokenCount > 0) {
    const liveTokenHint = `${String(liveTokenCount)} live token${liveTokenCount === 1 ? '' : 's'} · re-roll at Generate`;
    statusMessage = statusMessage ? `${statusMessage} · ${liveTokenHint}` : liveTokenHint;
  }
  const dangerTint = statusMessage !== '' && statusTone === 'danger';

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      id="atelier-composer"
      {...(collapsed ? { 'data-collapsed': 'true' } : {})}
      onFocus={() => { setComposerFocused(true); }}
      onPointerDownCapture={() => {
        // A press on non-focusable composer chrome blurs the textarea with a
        // null relatedTarget; remember the press so that blur is not read as
        // the operator leaving. Cleared on the next task, after blur has fired.
        pointerInsideRef.current = true;
        setTimeout(() => { pointerInsideRef.current = false; }, 0);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setComposerFocused(false);
        if (isPhone || collapsed || forceExpanded || composerHasContent) return;
        if (event.relatedTarget === null) {
          // Window blur, a press on composer chrome, or a control that just
          // disabled/unmounted itself (Clear after clearing, a removed ref chip)
          // all blur with no relatedTarget; none of them is the operator leaving.
          const source: unknown = event.target;
          const selfDisabled = source instanceof HTMLElement
            && ((source as HTMLElement & { disabled?: boolean }).disabled === true || !document.contains(source));
          if (!document.hasFocus() || pointerInsideRef.current || selfDisabled) return;
        }
        // Focus moving into a composer-owned popover (ChipSelect / PromptPicker
        // portal to body) or an App-level dialog opened from here (Tell Story)
        // is not the operator leaving the composer.
        if (event.currentTarget.contains(event.relatedTarget)
          || event.currentTarget.querySelector('[aria-haspopup][aria-expanded="true"]')
          || (event.relatedTarget instanceof Element && event.relatedTarget.closest('dialog, [role="dialog"]'))) return;
        setComposerMinimized(true);
      }}
      onDragEnter={(event) => {
        if (!isPhone && event.dataTransfer.types.includes('Files')) setComposerMinimized(false);
      }}
    >
      {collapsed ? (
        <CollapsedBar
          ref={collapsedExpandRef}
          prompt={isI2VMode ? (motionPrompt ?? '') : prompt}
          placeholder={isI2VMode ? 'Describe the motion…' : undefined}
          refCount={isI2VMode ? (i2vSourceUploadId ? 1 : 0) : refImages.length}
          queueLength={rollQueue.length}
          canSubmit={canSubmitNow}
          draining={canStop}
          onStop={onStopDraining}
          dangerTint={dangerTint}
          onExpand={() => {
            if (rollQueue.length > 0) setQueueExpanded(true);
            setComposerExpanded(true);
            if (!isPhone) {
              runWhenReachable(() => {
                const target = isI2VMode ? motionRef.current : textRef.current;
                target?.focus();
              }, wrapRef.current);
            }
          }}
          onSubmit={submit}
        />
      ) : (
      <div
        className={`${styles.composer} ${dragActive ? styles.dragActive : ''}`}
        data-testid="composer-drop-surface"
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          enqueueFiles(Array.from(event.dataTransfer.files));
        }}
        onPaste={(event) => {
          enqueueFiles(Array.from(event.clipboardData.files));
        }}
      >
        {!isPhone && (
          <button
            type="button"
            className={`${buttons.iconAction} ${styles.minimize}`}
            aria-label="Minimize composer"
            data-tip="Minimize"
            onClick={minimize}
          >
            <I.caret />
          </button>
        )}
        <button
          type="button"
          className={styles.collapseHandle}
          aria-label="Collapse composer"
          onClick={collapseWithFocusReturn}
        >
          <I.caret />
        </button>
        <RefImageRow
          files={refImages}
          maxRefImages={maxRefImages}
          onAdd={enqueueFiles}
          onRemove={(clientId) => {
            const ref = refImages.find((item) => item.clientId === clientId);
            if (ref) removeRef(ref);
          }}
          onCapReached={() => {
            addToast(`Maximum ${maxRefImages} reference image${maxRefImages === 1 ? '' : 's'}`, 'soft');
          }}
          disabled={disabled}
        />
        {isI2VMode ? (
          <div className={styles.videoPanel} data-zone="i2v">
            <div className={styles.sourceRow}>
              {i2vSourceUploadId ? (
                <div
                  className={styles.sourceThumb}
                  data-uploading={sourceUploading ? 'true' : undefined}
                  data-composing={resolving > 0 ? 'true' : undefined}
                >
                  <img src={refImageUrl(i2vSourceUploadId)} alt="Source still" draggable={false} />
                  {sourceUploading && <span className={styles.sourceThumbSpinner} aria-hidden="true" />}
                  <button
                    type="button"
                    className={styles.sourceReplace}
                    aria-label="Replace source still"
                    data-tip="Replace"
                    disabled={disabled || sourceUploading}
                    onClick={() => { sourceUploadRef.current?.click(); }}
                  >
                    <I.image />
                  </button>
                  <button
                    type="button"
                    className={styles.sourceClear}
                    aria-label="Remove source still"
                    data-tip="Remove"
                    disabled={disabled || sourceUploading}
                    onClick={clearSourceStill}
                  >
                    <I.close />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.sourceAdd}
                  aria-label="Add source still"
                  disabled={disabled || sourceUploading}
                  onClick={() => { sourceUploadRef.current?.click(); }}
                >
                  {sourceUploading ? <span className={styles.sourceThumbSpinner} aria-hidden="true" /> : <I.image />}
                  <span>{sourceUploading ? 'Uploading…' : 'Add source still'}</span>
                </button>
              )}
              <div className={styles.sourceMeta}>
                <span className={styles.sourceTitle}>{isExtendMode ? 'Handoff frame' : 'Source still'}</span>
                <span className={styles.sourceHint} aria-live="polite">
                  {resolving > 0 && i2vSourceUploadId ? (
                    <span className={styles.composing}>Composing motion…</span>
                  ) : i2vSourceUploadId ? (
                    isExtendMode ? 'Last frame of the previous clip' : 'The frame to animate'
                  ) : (
                    'Required — pick the frame to animate'
                  )}
                </span>
              </div>
              {exitToImageModelId && (
                <button
                  type="button"
                  className={`${styles.chip} ${styles.exitVideo}`}
                  aria-label="Back to image generation"
                  data-tip="Back to image generation"
                  disabled={disabled}
                  onClick={() => { handleModelChange(exitToImageModelId); }}
                >
                  <I.chevronLeft />
                  <span>Images</span>
                </button>
              )}
              <input
                ref={sourceUploadRef}
                className={styles.fileInput}
                type="file"
                accept={ACCEPTED_REF_ACCEPT}
                aria-label="Source still upload"
                onChange={(event) => {
                  uploadSourceStill(Array.from(event.target.files ?? [])).catch(() => undefined);
                  event.currentTarget.value = '';
                }}
              />
            </div>
            <label className={styles.motionField} htmlFor={motionPromptId}>
              <span className={styles.motionLabel}>Motion prompt</span>
              <textarea
                id={motionPromptId}
                ref={motionRef}
                aria-label="Motion prompt"
                className={styles.motionTextarea}
                value={motionPrompt ?? ''}
                placeholder="Describe camera motion, timing, and how the still should animate…"
                disabled={disabled || enhancing}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck
                onChange={(event) => { setDraft({ motionPrompt: event.target.value }); }}
                onKeyDown={handleKeyDown}
                rows={3}
              />
            </label>
          </div>
        ) : null}
        {!isI2VMode && (
          <textarea
            id={COMPOSER_PROMPT_ID}
            ref={textRef}
            aria-label="Prompt"
            className={styles.textarea}
            value={prompt}
            placeholder="Describe an image…"
            disabled={disabled || enhancing}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck
            onChange={(event) => { editPrompt(event.target.value); }}
            onKeyDown={handleKeyDown}
            rows={1}
          />
        )}
        {error && (
          <div className={styles.banner} role="alert">
            <span>{error}</span>
            <button type="button" className={styles.bannerAction} aria-label="Retry loading models" onClick={onRetryModels}>Retry</button>
          </div>
        )}

        {queueExpanded && rollQueue.length > 0 ? (
          <RollQueueList
            rolls={rollQueue}
            onRemove={removeQueuedRoll}
            onReorder={reorderQueuedRolls}
            onClear={clearRollQueue}
            targetContextLine={targetContextLine}
            pinnedHeaderRow={promptHasContent ? (
              <>
                <span aria-hidden="true">+</span>
                <span>Current prompt</span>
                <span>{prompt}</span>
              </>
            ) : undefined}
            variant="inline"
            ariaLabel="Composer roll-queue"
          />
        ) : null}
        <div className={styles.footer}>
          <div className={styles.controls} data-zone="controls">
            {promptPickerAvailable(promptsEnabled, selectedModel) && (
              <>
                <button
                  className={styles.chip}
                  type="button"
                  aria-label="Templates"
                  aria-haspopup="dialog"
                  aria-expanded={promptPickerOpen}
                  disabled={disabled || enhancing}
                  onClick={() => { if (promptPickerOpen) { closePicker(); } else { openPicker(); } }}
                >
                  <I.library />
                  <span className={styles.chipVal}>Library</span>
                  <I.caret className={styles.chipCaret} />
                </button>
                <PromptPicker
                  open={promptPickerOpen && !enhancing}
                  onClose={closePicker}
                  targetContextLine={targetContextLine}
                  modelOptions={modelOptions}
                  modelId={modelId}
                  onModelChange={handleModelChange}
                />
              </>
            )}
            {rollQueue.length > 0 ? (
              <button
                type="button"
                className={styles.queueChip}
                aria-expanded={queueExpanded}
                aria-label={`Roll-queue · ${String(rollQueue.length)}`}
                data-tip="View or edit queued rolls"
                onClick={() => { setQueueExpanded((open) => !open); }}
              >
                <I.layers />
                <span className={styles.queueCount}>{rollQueue.length}</span>
              </button>
            ) : null}
            {!isI2VMode && (
              <EnhanceControl
                enhancing={enhancing}
                canUndo={canUndo}
                disabled={disabled || !prompt.trim() || hasUploadingRefs || hasErrorRefs || refsOverCap}
                onEnhance={enhance}
                onUndo={undo}
              />
            )}
            {selectedModel.outputsVideo === true && onTellStory ? (
              <button
                type="button"
                className={buttons.ai}
                aria-haspopup="dialog"
                disabled={disabled || enhancing}
                onClick={onTellStory}
              >
                <I.sparkle aria-hidden="true" />
                Tell Story
              </button>
            ) : null}
            <div className={styles.selectGroup}>
              <ChipSelect<string>
                ariaLabel="Model"
                iconLeft={<I.chip />}
                valueDisplay={selectedModel.backend === 'local' ? (
                  <span className={styles.localToken}>
                    {shortModelToken(selectedModel)}
                    {localHostStatus ? <span className={styles.hostDot} data-state={localHostStatus} aria-hidden="true" /> : null}
                  </span>
                ) : shortModelToken(selectedModel)}
                valueTitle={`${selectedModel.name} — ${selectedModel.backend} · ${selectedModel.backend === 'local' ? hostLabel(selectedModel.tag) : selectedModel.tag}${localHostStatus ? ` · ${HOST_STATUS_WORDS[localHostStatus]}` : ''} · ${selectedModel.latency}`}
                options={modelOptions}
                value={modelId}
                disabled={disabled}
                onChange={handleModelChange}
              />
              <RatioChip
                supportedRatios={selectedModel.supportedRatios}
                value={ratio}
                disabled={disabled || isExtendMode}
                {...(isExtendMode ? { tip: 'Ratio is locked to the sequence' } : {})}
                onChange={onRatioChange}
              />
              {/*
                Video-only third axis. Sits between Ratio and Count so the row
                reads shape → length → quantity; on video rows Count is locked
                to x1, which keeps the row the same width as an image model's.
              */}
              {selectedModel.supportedDurations !== undefined && durationFrames !== undefined ? (
                <DurationChip
                  supportedDurations={selectedModel.supportedDurations}
                  value={durationFrames}
                  disabled={disabled}
                  onChange={onDurationChange}
                />
              ) : null}
              <ChipSelect<Count>
                ariaLabel="Count"
                valueDisplay={
                  countLocked ? (
                    <span className={styles.countLocked}>
                      ×1
                      <I.lock className={styles.countLockGlyph} aria-hidden="true" />
                    </span>
                  ) : `×${String(visibleCount)}`
                }
                options={countOptions}
                value={visibleCount}
                disabled={disabled || countLocked}
                {...(countLocked ? { tip: isLocalPool ? 'Local generation runs one tile at a time across all users' : 'This model starts one image per batch' } : {})}
                onChange={handleCountChange}
              />
            </div>
          </div>
          <div className={styles.dock} data-zone="dock">
            <button
              className={styles.clear}
              type="button"
              aria-label="Clear prompt and reference images"
              data-tip="Clear all"
              disabled={!canClear || enhancing}
              onClick={clearAll}
            >
              Clear
            </button>
            {canStop ? (
              <button
                className={styles.go}
                type="button"
                data-stop=""
                aria-label="Stop working through the queue"
                data-tip="Stop — keeps un-fired prompts in the queue"
                onClick={onStopDraining}
              >
                Stop
                <span className={styles.spinner} aria-hidden="true" />
              </button>
            ) : (
              <button
                className={styles.go}
                type="button"
                aria-disabled={generateDisabled || undefined}
                aria-describedby={generateDisabled && statusMessage ? statusId : undefined}
                data-working={resolving > 0 ? '' : undefined}
                data-tip={selectedModelOffline ? `${selectedModel.name} is offline` : undefined}
                onClick={submit}
              >
                {generateBaseLabel}
                {showRollCount ? <>{' '}<span className={styles.goCount}>{totalToFire}</span></> : null}
                {resolving > 0 ? <span className={styles.spinner} aria-hidden="true" /> : <I.arrow />}
              </button>
            )}
          </div>
        </div>
        <div className={styles.statusRail}>
          <div
            id={statusId}
            className={styles.statusline}
            data-zone="status"
            role="status"
            aria-live="polite"
            {...(statusMessage ? { 'data-tone': statusTone } : {})}
          >
            {statusMessage}
          </div>
          <div className={styles.activitySlot}>
            <InFlightIndicator
              pool={selectedModel.pool}
              cap={inFlightCap}
              modelById={modelById}
              preparing={preparing}
              aiFillActive={aiFillActive}
              labelById={aiFillLabelById}
            />
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

export default memo(Composer);
