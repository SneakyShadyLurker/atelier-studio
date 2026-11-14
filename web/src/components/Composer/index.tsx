import { MAX_TILE_COUNT, VAR_TOKEN_PATTERN } from '@atelier/shared';
import type { Model, Ratio } from '@atelier/shared';
import { AI_FILL_MAX_SLOTS, hasAiFillTokens, parseAiFillTokens } from '@atelier/shared/ai-fill';
import { addTransitionType, memo, startTransition, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, ViewTransition, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { textModelsOpts } from '../../api/textModels';
import { refImageThumbUrl, uploadRefImage } from '../../api/uploads';
import { useCachedMedia } from '../../hooks/useCachedMedia';
import { useHistoryWorkRunning } from '../../hooks/useHistoryWorkRunning';
import { COMPOSER_BODY_UPDATE, COMPOSER_PARTS_TRANSITION, composerPartsReshaped } from '../../lib/composerMotion';
import { beginSourceHandoff, supersedeSourceHandoffs } from '../../lib/composerSourceHandoff';
import { isModelAvailable } from '../../lib/effectiveModel';
import { I2V_ESTIMATED_LABEL } from '../../lib/i2v';
import { isImeComposing } from '../../lib/ime';
import { promptPickerAvailable } from '../../lib/modelSelection';
import { describeError } from '../../lib/errorCopy';
import { runWhenReachable } from '../../lib/focus';
import { goToTextModels } from '../../lib/textModelsNav';
import { useDeleteUpload } from '../../hooks/useDeleteUpload';
import { useAttachRefImages } from '../../hooks/useAttachRefImages';
import { useComposerViewportInsets } from '../../hooks/useComposerViewportInsets';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useProbeModel } from '../../hooks/useProbeModel';
import { useKeyboardScopeActive, useKeyboardScoped } from '../../hooks/useKeyboard';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { useTextModelGate } from '../../hooks/useTextModelGate';
import type { Count, RefImageDraft } from '../../store/atelier';
import { canSubmitDraft, holdUploadsForUndo, MAX_REF_IMAGES_FALLBACK, useAtelierStore } from '../../store/atelier';
import { Disclosure } from '../Disclosure';
import { I } from '../icons/I';
import ChipSelect, { type ChipSelectOption } from './ChipSelect';
import { CollapsedBar } from './CollapsedBar';
import { registerComposerYield } from './composerYield';
import { protectPresses } from '../../lib/viewTransitionGuard';
import { useComposerIdleYield } from './useComposerIdleYield';
import { elementContainsPoint, useRootClickRescue } from './useRootClickRescue';
import EnhanceControl from './EnhanceControl';
import InFlightIndicator from './InFlightIndicator';
import { hostLabel, shortModelToken } from './modelToken';
import PromptPicker from '../PromptPicker';
import TextModelNote from '../TextModelNote';
import RatioChip from './RatioChip';
import DurationChip from './DurationChip';
import type { VideoDurationFrames } from '@atelier/shared';
import { ACCEPTED_REF_ACCEPT, RefImageRow } from './RefImageRow';
import RollQueueList from '../RollQueueList';
import { Meta } from '../Meta';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

// The feed's row list (Canvas): batches and their tiles.
const FEED_ROWS_SELECTOR = '[data-virtualized="canvas"]';

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

// The source still is shown at chip size, so it reads the upload's thumbnail
// through the session media cache instead of the full, no-store original.
function SourceStillThumb({ uploadId }: { uploadId: string }) {
  const { src } = useCachedMedia(refImageThumbUrl(uploadId));
  return <img src={src} alt="Source still" draggable={false} />;
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
  modelsPending?: boolean;
  onPromptChange: (prompt: string) => void;
  onModelChange: (modelId: string) => void;
  onRatioChange: (ratio: Ratio) => void;
  /** Present only when the selected model is a video row; drives the chip's visibility. */
  durationFrames?: VideoDurationFrames | undefined;
  onDurationChange: (frames: VideoDurationFrames) => void;
  onCountChange: (count: Count) => void;
  onSubmit: () => void;
  /** Enhance and generate: rewrite the prompt as it stands and generate from the rewrite. */
  onSubmitEnhanced?: () => void;
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
  modelsPending = false,
  onPromptChange,
  onModelChange,
  onRatioChange,
  durationFrames,
  onDurationChange,
  onCountChange,
  onSubmit,
  onSubmitEnhanced = () => undefined,
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
  const goRef = useRef<HTMLButtonElement | null>(null);
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const barGoRef = useRef<HTMLButtonElement | null>(null);
  const barStopRef = useRef<HTMLButtonElement | null>(null);
  const barEnhanceRef = useRef<HTMLButtonElement | null>(null);
  // Desktop yield guards that no render reads: the pointer resting over the
  // Composer and an IME composition in one of its fields.
  const pointerOverRef = useRef(false);
  const imeComposingRef = useRef(false);
  const motionPromptId = useId();
  const statusId = useId();
  const [dragActive, setDragActive] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const pointerInsideRef = useRef(false);
  // Unsent edits, per field (R24 idle yield): the reader typed in it since
  // the last submit, and it no longer holds what that submit sent.
  const typedRef = useRef({ image: false, motion: false });
  const submittedRef = useRef<{ image: string | null; motion: string | null }>({ image: null, motion: null });
  // Fields the reader has put a caret in since they mounted. A fresh field
  // reports its selection at 0 whatever it holds, so only these are trusted.
  const caretFieldsRef = useRef(new WeakSet<HTMLTextAreaElement>());
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
  const queuePanelId = useId();
  const rollQueue = useAtelierStore((state) => state.draft.rollQueue);
  const resolving = useAtelierStore((state) => state.resolving);
  const resolvingEnhance = useAtelierStore((state) => state.resolvingEnhance);
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
  // Work is running while tiles load in history (a boolean read of the cache,
  // so a stream's tile events do not re-render the Composer), the roll queue
  // drains or prompts are still being prepared.
  const historyWorkRunning = useHistoryWorkRunning();
  const workRunning = historyWorkRunning || draining || preparing > 0;
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
  const composerExpanded = useAtelierStore((state) => state.composerExpanded);
  const composerMinimized = useAtelierStore((state) => state.composerMinimized);
  const setComposerMinimized = useAtelierStore((state) => state.setComposerMinimized);
  const previousComposerExpanded = useRef(composerExpanded);
  const setComposerExpanded = useAtelierStore((state) => state.setComposerExpanded);
  const attachRefImages = useAttachRefImages();
  const deleteUpload = useDeleteUpload();
  const probeMutation = useProbeModel();
  // AI actions stay enabled without a text model; with none configured at
  // all, pressing one opens the note under it instead (decision 3).
  const textModelGate = useTextModelGate();
  const enhanceButtonRef = useRef<HTMLButtonElement | null>(null);
  const tellStoryButtonRef = useRef<HTMLButtonElement | null>(null);
  const [textNote, setTextNote] = useState<{ action: string; anchorRef: RefObject<HTMLButtonElement | null> } | null>(null);
  const gateTextAction = (action: string, anchorRef: RefObject<HTMLButtonElement | null>, run: () => void) => {
    if (textModelGate.availability === 'none') setTextNote({ action, anchorRef });
    else run();
  };
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
  // One render snapshot for the conditional parts (banner, ref chips, queue
  // chip and list, collapsed-bar badges, mode body): they render from it, so a
  // part mounts or unmounts in a Transition and its <ViewTransition> plays,
  // while the frame boundary in App.tsx interpolates the footprint. Typing
  // never touches it: the prompt is not in it. Handlers act on the live
  // queue and refs (a view transition holds the deferred commit). The commit
  // carries COMPOSER_PARTS_TRANSITION, the only type the frame and mode body
  // animate for (useDeferredValue cannot carry a type), and only when a part
  // appears or leaves (composerPartsReshaped), so neither a batch entering the
  // feed nor a press bumping the queue count captures the Composer, and
  // Generate stays pressable.
  const noModels = models.length === 0;
  const liveParts = useMemo(() => ({
    banner: noModels && !modelsPending ? (error ?? 'Models unavailable') : null,
    error,
    rollQueue,
    refImages,
    isI2VMode,
  }), [noModels, modelsPending, error, rollQueue, refImages, isI2VMode]);
  const [parts, setParts] = useState(liveParts);
  const scheduledPartsRef = useRef(liveParts);
  useEffect(() => {
    const drainRunning = useAtelierStore.getState().draining;
    const reshaped = composerPartsReshaped(scheduledPartsRef.current, liveParts, drainRunning);
    scheduledPartsRef.current = liveParts;
    // Even enter="none" can start a native view transition when its React
    // boundary mounts. A drain's take/restore/count commits own no motion:
    // keep them urgent, outside the document-wide capture preparation window.
    if (drainRunning && !reshaped) {
      setParts(liveParts);
      return;
    }
    startTransition(() => {
      if (reshaped) addTransitionType(COMPOSER_PARTS_TRANSITION);
      setParts(liveParts);
    });
  }, [liveParts]);
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
    // An offline row cannot be switched to, so it would strand the user in
    // video mode; prefer an available image model, then any image model.
    if (remembered && isImageModel(remembered) && isModelAvailable(remembered)) return remembered.id;
    let firstImageModelId: string | undefined;
    for (const model of modelById.values()) {
      if (!isImageModel(model)) continue;
      if (isModelAvailable(model)) return model.id;
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- React Compiler 1.0 cannot lower `??=` and would skip memoizing the whole Composer.
      if (firstImageModelId === undefined) firstImageModelId = model.id;
    }
    return remembered && isImageModel(remembered) ? remembered.id : firstImageModelId;
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
  const generateDisabled = disabled || !hasSubmittableInput || hasUploadingRefs
    || hasErrorRefs || refsUnsupported || !draftSubmittable || refsOverCap || selectedModelOffline || aiFillExceeded
    || sourceUploading || missingI2VSource || missingMotion;
  const canSubmitNow = !generateDisabled;
  const totalToFire = rollQueue.length + (promptHasContent ? 1 : 0);
  const generateBaseLabel = isExtendMode ? 'Extend' : isI2VMode ? 'Animate' : 'Generate';
  const showRollCount = !isI2VMode && rollQueue.length > 0;
  const targetModelName = selectedModel?.name ?? 'selected model';
  const targetContextLine = (
    <Meta items={[
      `Will run on ${targetModelName}`,
      ratio,
      `×${String(visibleCount)}`,
      `${String(refImages.length)} ref${refImages.length === 1 ? '' : 's'}`,
    ]} />
  );
  const modelOptions = useMemo<readonly ChipSelectOption<string>[]>(() => {
    const local = models.filter((model) => model.backend === 'local');
    const cloud = models.filter((model) => model.backend === 'cloud');
    const toOption = (model: Model): ChipSelectOption<string> => {
      const offline = model.availability && !model.availability.ok;
      // Two disabled states, two different hint labels. `Needs your API key`
      // (behind a lock) is BYOK without a configured key — clicking opens the
      // key manager. `Offline` means the server's health probe says the
      // upstream host is unreachable; clicking starts an on-demand probe in
      // handleModelChange below.
      // Local models advertise their host tag (`comfyui`); cloud models
      // keep their free-form locator tag (e.g. `google`). A locator that only
      // repeats the group header word (`cloud` under Cloud) is dropped.
      const group = model.backend === 'local' ? 'Local' : 'Cloud';
      const locator = model.backend === 'local' ? hostLabel(model.tag) : model.tag;
      let hint: string | undefined;
      if (model.requiresKey) hint = 'Needs your API key';
      else if (probingModelId === model.id) hint = 'Checking…';
      else if (offline) hint = 'Offline';
      else if (locator.toLowerCase() !== group.toLowerCase()) hint = locator;
      const baseTitle = `${model.backend}, ${locator}, ${model.latency}`;
      const title = offline && model.availability
        ? `${baseTitle}, host offline (${formatCheckedAgo(model.availability.checkedAt)})`
        : baseTitle;
      return {
        value: model.id,
        label: model.name,
        ...(hint === undefined ? {} : { hint }),
        ...(offline && !model.requiresKey && probingModelId !== model.id ? { hintAction: 'Check again' } : {}),
        ...(model.requiresKey ? { hintIcon: <I.lock /> } : {}),
        group,
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
  // R24: the desktop Composer yields the viewport to the feed, text or not.
  // It stays while the reader is using it: an owned popover or dialog, an
  // upload, an IME composition, or (for scroll and idle) the
  // pointer resting on it. Only popover triggers count (ChipSelect,
  // Templates): a persistent disclosure such as the roll-queue expander must
  // not pin the composer open.
  const yieldBlocked = (pointerMatters: boolean): boolean => {
    const wrap = wrapRef.current;
    if (!wrap || isPhone || collapsed || forceExpanded) return true;
    if ((pointerMatters && pointerOverRef.current) || imeComposingRef.current) return true;
    if (hasUploadingRefs || sourceUploading || textNote !== null) return true;
    if (wrap.querySelector('[aria-haspopup][aria-expanded="true"]')) return true;
    const active = document.activeElement;
    return active instanceof Element && active.closest('dialog, [role="dialog"], [role="listbox"], [role="menu"]') !== null;
  };
  // Scroll and idle: focus inside the Composer moves to the collapsed bar,
  // as minimize() does; focus elsewhere stays where the reader put it.
  const yieldViewport = () => {
    if (yieldBlocked(true)) return;
    if (wrapRef.current?.contains(document.activeElement)) minimize();
    else setComposerMinimized(true);
  };
  // A press in the feed. "Outside" is decided by the pointer's point against
  // the Composer's box, not only the target: during a feed transition WebKit
  // hit-tests a press on the captured Composer through to the feed behind
  // it, and capture preparation delivers it to the root. The press then
  // places focus itself, so none is moved here.
  // A Composer holding a draft yields only to the feed's own rows (batches
  // and tiles): there the reader is looking at results. A press on a feed
  // state with nothing to view (the empty invitation, a load error's Retry),
  // the view header, the sidebar or a dialog leaves the draft in sight. An
  // empty Composer keeps yielding to any press outside it.
  useOutsidePointer([wrapRef], (event) => {
    const wrap = wrapRef.current;
    if (!wrap || yieldBlocked(false)) return;
    if (event instanceof MouseEvent && elementContainsPoint(wrap, event.clientX, event.clientY)) return;
    const target = event.target;
    const inFeedRows = target instanceof Element && target.closest(FEED_ROWS_SELECTOR) !== null;
    if (composerHasContent && !inFeedRows) return;
    setComposerMinimized(true);
  }, { enabled: !isPhone && !collapsed && !forceExpanded });
  useEffect(() => registerComposerYield(yieldViewport));
  // Idle is not leaving: a caret resting in a field the reader has typed in
  // since the last submit, whose text is not what that submit sent, is the
  // reader composing the next prompt, however long the pause. A scroll or a
  // press on the feed still yields, and so does text that only sits there
  // (a draft never typed in, or edited back to what was sent).
  const composing = (): boolean => {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement) || active.value.trim().length === 0) return false;
    if (active === textRef.current) return typedRef.current.image && active.value !== submittedRef.current.image;
    if (active === motionRef.current) return typedRef.current.motion && active.value !== submittedRef.current.motion;
    return false;
  };
  useComposerIdleYield(wrapRef, !isPhone && !collapsed && !forceExpanded && workRunning, () => {
    if (!composing()) yieldViewport();
  });
  // Presses inside the dock reach it even while a view transition has it
  // captured (lib/viewTransitionGuard).
  useEffect(() => {
    const wrap = wrapRef.current;
    return wrap ? protectPresses(wrap) : undefined;
  });
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

  // Phone only: focus the textarea on expand and restore the stable
  // collapsed-bar control after an expanded→collapsed transition.
  // This covers every dismissal path, including App's scrim and Canvas's
  // scroll-collapse, whose callers do not have access to this local ref.
  useEffect(() => {
    if (!isPhone) {
      previousComposerExpanded.current = composerExpanded;
      return;
    }
    if (composerExpanded && !previousComposerExpanded.current) {
      const target = parts.isI2VMode ? motionRef.current : textRef.current;
      runWhenReachable(() => { target?.focus(); }, target);
    } else if (!composerExpanded && previousComposerExpanded.current) {
      collapsedExpandRef.current?.focus();
    }
    previousComposerExpanded.current = composerExpanded;
  }, [composerExpanded, isPhone, parts.isI2VMode]);

  // One guard for both fire actions, so Generate and Enhance cannot drift.
  const fire = (run: () => void) => {
    if (retryingPrepared || !selectedModel) return;
    if (selectedModel.requiresKey) {
      useAtelierStore.getState().openByok();
      return;
    }
    if (selectedModel.availability && !selectedModel.availability.ok) {
      addToast(`${selectedModel.name} is offline`, 'error');
      return;
    }
    if (generateDisabled) return;
    typedRef.current = { image: false, motion: false };
    submittedRef.current = { image: prompt, motion: motionPrompt ?? '' };
    run();
  };
  const submit = () => { fire(onSubmit); };
  // Enhance and generate, image mode only. A missing text model opens the
  // note anchored to the pressed button (the dock's or the collapsed bar's).
  // It rewrites the prompt in the Composer and nothing else, so it needs one:
  // rolls waiting in the queue are Generate's to fire.
  const enhanceAvailable = !isI2VMode;
  const canEnhanceNow = enhanceAvailable && promptHasContent && canSubmitNow && !retryingPrepared;
  const enhanceFrom = (anchorRef: RefObject<HTMLButtonElement | null>) => {
    if (!enhanceAvailable || !promptHasContent) return;
    fire(() => { gateTextAction('Enhance', anchorRef, onSubmitEnhanced); });
  };
  const enhanceWorking = resolvingEnhance > 0 && !canStop;
  const generateWorking = resolving - resolvingEnhance > 0 && !canStop;

  // R25: a press on Generate or Stop survives the frames in which a view
  // transition's capture suspends hit-testing (the click lands on the root).
  useRootClickRescue([
    { ref: collapsed ? barStopRef : stopRef, active: canStop, activate: onStopDraining },
    { ref: collapsed ? barGoRef : goRef, active: canSubmitNow && !retryingPrepared, activate: submit },
    // Enhance is pressed repeatedly, and each fire starts the feed transition
    // that would swallow the next press.
    {
      ref: collapsed ? barEnhanceRef : enhanceButtonRef,
      active: canEnhanceNow,
      activate: () => { enhanceFrom(collapsed ? barEnhanceRef : enhanceButtonRef); },
    },
  ]);

  // A printable key on the focused collapsed bar: expand, focus the field
  // and type that one character where the caret was. The hidden field keeps
  // the selection it had when the Composer minimized, so typing resumes in
  // place and replaces a selection, as it would have in the open field. A
  // field the reader has not focused since it mounted has no caret of theirs
  // (it reports 0): there the character goes at the end.
  const typeIntoComposer = (character: string) => {
    const field = parts.isI2VMode ? motionRef.current : textRef.current;
    const value = parts.isI2VMode ? (motionPrompt ?? '') : prompt;
    const placed = field !== null && caretFieldsRef.current.has(field);
    const start = placed ? Math.min(field.selectionStart, value.length) : value.length;
    const end = placed ? Math.min(Math.max(field.selectionEnd, start), value.length) : value.length;
    const next = `${value.slice(0, start)}${character}${value.slice(end)}`;
    const caret = start + character.length;
    typedRef.current[parts.isI2VMode ? 'motion' : 'image'] = true;
    setComposerExpanded(true);
    if (parts.isI2VMode) setDraft({ motionPrompt: next });
    else onPromptChange(next);
    // React writes the new value before this microtask runs; a value write
    // moves the caret to the end, so the caret is placed after it.
    runWhenReachable(() => {
      const target = parts.isI2VMode ? motionRef.current : textRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(caret, caret);
    }, wrapRef.current);
  };

  // The failed-inventory banner stays (from the snapshot) until the deferred
  // render removes it, so it leaves through its boundary when models arrive.
  // Pending inventory swaps to the form at once: no transition at load.
  if (noModels || parts.banner !== null) {
    return (
      <div ref={wrapRef} className={styles.wrap} id="atelier-composer" data-collapsed={collapsed ? 'true' : undefined}>
        <div className={`${styles.composer} ${styles.inventoryState}`}>
          {modelsPending && noModels ? (
            <div className={styles.inventoryLoading} role="status">
              <span>Loading models…</span>
            </div>
          ) : null}
          {parts.banner !== null ? (
            <ViewTransition default="none" enter="part-enter" exit="part-exit">
              <div className={styles.banner} role="alert">
                <span>{parts.banner}</span>
                <button type="button" className={styles.bannerAction} aria-label="Retry loading models" onClick={onRetryModels}>Retry</button>
              </div>
            </ViewTransition>
          ) : null}
        </div>
      </div>
    );
  }

  if (!selectedModel) return null;

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
    // still in flight must not switch the model or video draft back. That
    // includes picking the displayed fallback over a remembered selection
    // (draft.modelId), which App commits as an explicit choice.
    if (next !== modelIdAtStart || useAtelierStore.getState().draft.modelId !== next) supersedeSourceHandoffs();
    if (candidate?.availability && !candidate.availability.ok) {
      // ChipSelect renders the option with `aria-disabled` + a styles hook,
      // but its click / keyboard-Enter handlers do NOT gate on `disabled`
      // (mirrors the BYOK gate: clicking "Needs your API key" opens the BYOK pane
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
      // Settled as a value rather than try/catch/finally: React Compiler
      // cannot yet lower a `finally` clause and would skip memoizing the
      // whole Composer.
      const settled = await probePromise.then(
        (refreshedModels) => ({ ok: true as const, refreshedModels }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (modelIntentRef.current !== intent || activeModelIdRef.current !== modelIdAtStart) return;
      setProbingModelId(null);
      if (!settled.ok) {
        const reason = describeError(settled.error, 'request failed');
        addToast(`Couldn't re-check ${candidate.name} — ${reason}`, 'error');
        return;
      }
      const refreshed = settled.refreshedModels.find((model) => model.id === candidate.id);
      if (!refreshed || refreshed.availability?.ok === false) {
        addToast(`${candidate.name} is offline`, 'error');
        return;
      }
      onModelChange(next);
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
      // Shift adds Enhance: rewrite and generate. Without it, plain Generate.
      if (event.shiftKey) enhanceFrom(enhanceButtonRef);
      else submit();
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
    const upload = await uploadRefImage(file).catch(() => null);
    setSourceUploading(false);
    if (!isCurrent()) return;
    if (upload === null) {
      addToast('Source still upload failed', 'error');
      return;
    }
    // A manually-uploaded still has no known generation prompt — clear any
    // i2vSourcePrompt carried over from a prior Animate so the motion enhancer
    // never anchors this still to a different subject's prompt.
    setDraft({
      i2vSourceUploadId: upload.id,
      i2vSourcePrompt: undefined,
      extendsTileId: undefined,
      extendPrevPrompt: undefined,
    });
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
    const snapshot = { prompt, refImages, i2vSourceUploadId, i2vSourcePrompt, motionPrompt, extendsTileId, extendPrevPrompt };
    const releaseUndoHold = holdUploadsForUndo([
      ...refImages.flatMap((ref) => (ref.serverId ? [ref.serverId] : [])),
      ...(i2vSourceUploadId ? [i2vSourceUploadId] : []),
    ]);
    let undone = false;
    supersedeSourceHandoffs();
    setDraft({
      prompt: '',
      refImages: [],
      i2vSourceUploadId: undefined,
      i2vSourcePrompt: undefined,
      motionPrompt: undefined,
      extendsTileId: undefined,
      extendPrevPrompt: undefined,
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
  } else if (resolvingEnhance > 0) {
    statusMessage = resolvingEnhance === 1 ? 'Enhancing prompt' : `Enhancing ${String(resolvingEnhance)} prompts`;
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
    statusMessage = `${aiFillCount} AI fills, up to ${AI_FILL_MAX_SLOTS} allowed`;
    statusTone = 'danger';
  } else if (!isI2VMode && aiFillCount > 0 && textModelGate.availability === 'none') {
    statusMessage = 'AI fills need a text model';
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
    statusMessage = `Sequence handoff ready, ${I2V_ESTIMATED_LABEL} render`;
    statusTone = 'info';
  } else if (countLocked) {
    statusMessage = isI2VMode ? `One clip, ${I2V_ESTIMATED_LABEL} render` : (isLocalPool ? 'One tile at a time' : 'One image per batch');
    statusTone = 'info';
  } else if (maxCountPerBatch < MAX_TILE_COUNT) {
    statusMessage = `Up to ${String(maxCountPerBatch)} images per batch`;
    statusTone = 'info';
  }
  const liveTokenCount = isI2VMode ? 0 : countLiveTokens(prompt);
  if (liveTokenCount > 0) {
    const liveTokenHint = `${String(liveTokenCount)} live token${liveTokenCount === 1 ? '' : 's'}, re-rolled at Generate`;
    statusMessage = statusMessage ? `${statusMessage}, ${liveTokenHint}` : liveTokenHint;
  }
  const dangerTint = statusMessage !== '' && statusTone === 'danger';

  return (
    <div
      ref={wrapRef}
      className={`${styles.wrap} ${dragActive ? styles.dragActive : ''}`}
      id="atelier-composer"
      {...(collapsed ? { 'data-collapsed': 'true' } : {})}
      data-tone={collapsed && dangerTint ? 'danger' : undefined}
      onFocus={() => { setComposerFocused(true); }}
      onPointerEnter={() => { pointerOverRef.current = true; }}
      onPointerLeave={() => { pointerOverRef.current = false; }}
      onCompositionStart={() => { imeComposingRef.current = true; }}
      onCompositionEnd={() => { imeComposingRef.current = false; }}
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
      <div className={styles.compactSurface} inert={!collapsed} aria-hidden={!collapsed}>
        <CollapsedBar
          ref={collapsedExpandRef}
          prompt={isI2VMode ? (motionPrompt ?? '') : prompt}
          placeholder={isI2VMode ? 'Describe the motion…' : undefined}
          refCount={parts.isI2VMode ? (i2vSourceUploadId ? 1 : 0) : parts.refImages.length}
          queueLength={parts.rollQueue.length}
          canSubmit={canSubmitNow && !retryingPrepared}
          draining={canStop}
          onStop={onStopDraining}
          dangerTint={dangerTint}
          onExpand={() => {
            if (rollQueue.length > 0) setQueueExpanded(true);
            setComposerExpanded(true);
            if (!isPhone) {
              runWhenReachable(() => {
                const target = parts.isI2VMode ? motionRef.current : textRef.current;
                target?.focus();
              }, wrapRef.current);
            }
          }}
          onSubmit={submit}
          onType={typeIntoComposer}
          generateRef={barGoRef}
          stopRef={barStopRef}
          enhance={enhanceAvailable && promptHasContent ? {
            working: enhanceWorking,
            needsTextModel: textModelGate.availability === 'none',
            iconOnly: isPhone,
            onEnhance: () => { enhanceFrom(barEnhanceRef); },
            ref: barEnhanceRef,
          } : undefined}
        />
      </div>
      <div className={styles.expandedTrack} inert={collapsed} aria-hidden={collapsed}>
      <div className={styles.expandedClip}>
      <div
        className={`${styles.composer} ${parts.isI2VMode ? '' : styles.imageComposer}`}
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
          files={parts.refImages}
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
        {/* The mode body: image and video fields cross-fade in one slot while
            the frame boundary (App.tsx) carries the footprint change. */}
        <ViewTransition default="none" update={COMPOSER_BODY_UPDATE}>
        {parts.isI2VMode ? (
          <div key="i2v" className={styles.videoPanel} data-zone="i2v">
            <div className={styles.sourceRow}>
              {i2vSourceUploadId ? (
                <div
                  className={styles.sourceThumb}
                  data-uploading={sourceUploading ? 'true' : undefined}
                  data-composing={resolving > 0 ? 'true' : undefined}
                >
                  <SourceStillThumb uploadId={i2vSourceUploadId} />
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
                  aria-busy={sourceUploading || undefined}
                  data-tip="Add source still"
                  disabled={disabled || sourceUploading}
                  onClick={() => { sourceUploadRef.current?.click(); }}
                >
                  {sourceUploading ? <span className={styles.sourceThumbSpinner} aria-hidden="true" /> : <I.image />}
                </button>
              )}
              <div className={styles.sourceMeta}>
                <span className={styles.sourceTitle}>{isExtendMode ? 'Handoff frame' : 'Source still'}</span>
                <span className={styles.sourceHint} aria-live="polite">
                  {resolving > 0 && i2vSourceUploadId ? (
                    <span className={styles.composing}>Composing motion…</span>
                  ) : i2vSourceUploadId ? (
                    isExtendMode ? 'Last frame of the previous clip' : 'The frame to animate'
                  ) : sourceUploading ? (
                    'Uploading…'
                  ) : (
                    'Required: pick the frame to animate'
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
                disabled={disabled}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck
                onChange={(event) => {
                  typedRef.current.motion = true;
                  setDraft({ motionPrompt: event.target.value });
                }}
                onFocus={(event) => { caretFieldsRef.current.add(event.currentTarget); }}
                onKeyDown={handleKeyDown}
                rows={3}
              />
            </label>
          </div>
        ) : (
          <textarea
            key="image"
            id={COMPOSER_PROMPT_ID}
            ref={textRef}
            aria-label="Prompt"
            className={styles.textarea}
            value={prompt}
            placeholder="Describe an image…"
            disabled={disabled}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck
            onChange={(event) => {
              typedRef.current.image = true;
              onPromptChange(event.target.value);
            }}
            onFocus={(event) => { caretFieldsRef.current.add(event.currentTarget); }}
            onKeyDown={handleKeyDown}
            rows={1}
          />
        )}
        </ViewTransition>
        {parts.error ? (
          <ViewTransition default="none" enter="part-enter" exit="part-exit">
            <div className={styles.banner} role="alert">
              <span>{parts.error}</span>
              <button type="button" className={styles.bannerAction} aria-label="Retry loading models" onClick={onRetryModels}>Retry</button>
            </div>
          </ViewTransition>
        ) : null}

        {/* A drain takes and restores the whole queue on each pass. Like the
            frame's reshape gate, its parts must ignore those bookkeeping
            mounts/unmounts, so a capture cannot swallow a Generate press. */}
        {parts.rollQueue.length > 0 ? (
          <ViewTransition default="none" enter={draining ? 'none' : 'part-enter'} exit={draining ? 'none' : 'part-exit'}>
          <Disclosure
            id={queuePanelId}
            open={queueExpanded}
            className={styles.queueDisclosure}
            contentClassName={styles.queueDisclosureContent}
          >
            <RollQueueList
              rolls={parts.rollQueue}
              liveRolls={rollQueue}
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
          </Disclosure>
          </ViewTransition>
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
                  disabled={disabled}
                  onClick={() => { if (promptPickerOpen) { closePicker(); } else { openPicker(); } }}
                >
                  <I.library />
                  <span className={styles.chipVal}>Templates</span>
                  <I.caret className={styles.chipCaret} />
                </button>
                <PromptPicker
                  open={promptPickerOpen}
                  onClose={closePicker}
                  targetContextLine={targetContextLine}
                  modelOptions={modelOptions}
                  modelId={modelId}
                  onModelChange={handleModelChange}
                />
              </>
            )}
            {parts.rollQueue.length > 0 ? (
              <ViewTransition default="none" enter={draining ? 'none' : 'part-enter'} exit={draining ? 'none' : 'part-exit'}>
              <button
                type="button"
                className={styles.queueChip}
                aria-expanded={queueExpanded}
                aria-controls={queuePanelId}
                aria-label={`Roll queue, ${String(parts.rollQueue.length)} ${parts.rollQueue.length === 1 ? 'roll' : 'rolls'}`}
                data-tip="View or edit queued rolls"
                onClick={() => { setQueueExpanded((open) => !open); }}
              >
                <I.layers />
                <span className={styles.queueCount}>{parts.rollQueue.length}</span>
              </button>
              </ViewTransition>
            ) : null}
            {selectedModel.outputsVideo === true && onTellStory ? (
              <button
                ref={tellStoryButtonRef}
                type="button"
                className={buttons.ai}
                aria-haspopup="dialog"
                data-tip={textModelGate.availability === 'none' ? 'Needs a text model' : undefined}
                disabled={disabled}
                onClick={() => { gateTextAction('Tell Story', tellStoryButtonRef, onTellStory); }}
              >
                <I.sparkle aria-hidden="true" />
                Tell Story
              </button>
            ) : null}
            {textNote ? (
              <TextModelNote
                open
                action={textNote.action}
                anchorRef={textNote.anchorRef}
                escape="top-level"
                navigateToTextModels={goToTextModels}
                onClose={() => { setTextNote(null); }}
              />
            ) : null}
            <div className={styles.selectGroup}>
              <ChipSelect<string>
                ariaLabel="Model"
                iconLeft={<I.chip />}
                valueDisplay={selectedModel.backend === 'local' ? (
                  <span className={styles.localToken}>
                    <span>{shortModelToken(selectedModel)}</span>
                    {localHostStatus ? <span className={styles.hostDot} data-state={localHostStatus} aria-hidden="true" /> : null}
                  </span>
                ) : shortModelToken(selectedModel)}
                valueTitle={`${selectedModel.name}: ${selectedModel.backend}, ${selectedModel.backend === 'local' ? hostLabel(selectedModel.tag) : selectedModel.tag}${localHostStatus ? `, ${HOST_STATUS_WORDS[localHostStatus]}` : ''}, ${selectedModel.latency}`}
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
              disabled={!canClear}
              onClick={clearAll}
            >
              Clear
            </button>
            {/* Stop sits beside Generate, never in its place: a press while
                the queue drains joins the queue, so Generate stays pressable
                for as long as the server holds rolls back at capacity. */}
            {canStop ? (
              <button
                ref={stopRef}
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
            ) : null}
            {/* Enhance sits immediately left of Generate in the spatially
                fixed dock: a button meant for repeated presses must not move
                when the controls zone wraps. */}
            {enhanceAvailable ? (
              <EnhanceControl
                working={enhanceWorking}
                disabled={!canEnhanceNow}
                needsTextModel={textModelGate.availability === 'none'}
                onEnhance={() => { enhanceFrom(enhanceButtonRef); }}
                enhanceRef={enhanceButtonRef}
              />
            ) : null}
            {retryingPrepared ? null : (
              <button
                ref={goRef}
                className={styles.go}
                type="button"
                aria-disabled={generateDisabled || undefined}
                aria-describedby={generateDisabled && statusMessage ? statusId : undefined}
                data-working={generateWorking ? '' : undefined}
                data-tip={selectedModelOffline ? `${selectedModel.name} is offline` : undefined}
                onClick={submit}
              >
                {generateBaseLabel}
                {showRollCount ? <>{' '}<span className={styles.goCount}>{totalToFire}</span></> : null}
                {generateWorking ? <span className={styles.spinner} aria-hidden="true" /> : null}
              </button>
            )}
          </div>
        </div>
        <div className={styles.statusRail}>
          {/* The help line: the shortcut hint (visual only; the live region
              stays the status message alone), then the dynamic status. */}
          <Meta className={styles.helpLine} items={[
            <span key="shortcut" className={styles.helpShortcut} aria-hidden="true">
              <kbd className={styles.kbd}>⌘</kbd><kbd className={styles.kbd}>↵</kbd> to generate
            </span>,
            <div
              key="status"
              id={statusId}
              className={styles.statusline}
              data-zone="status"
              role="status"
              aria-live="polite"
              {...(statusMessage ? { 'data-tone': statusTone } : {})}
            >
              {statusMessage}
            </div>,
          ]} />
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
      </div>
      </div>
    </div>
  );
}

export default memo(Composer);
