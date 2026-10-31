/*
 * Overlay harness for the real-browser lane (web/e2e/*.spec.ts).
 *
 * Mounts ONLY the shared overlay scaffolds, with stub data, so the browser
 * specs can assert focus containment, Escape, light dismiss and background
 * inerting without booting the API. Dev-server only — Vite builds `index.html`
 * alone (see build.rollupOptions.input), so nothing here reaches dist.
 */
import type { Batch, GptModerationNotice, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import BatchOverflowMenu from '../../src/components/BatchOverflowMenu';
import CharacterCardDialog from '../../src/components/CharacterCardDialog';
import Canvas from '../../src/components/Canvas';
import { DialogShell } from '../../src/components/DialogShell';
import dialogStyles from '../../src/styles/dialog.module.css';
import Lightbox from '../../src/components/Lightbox';
import ImageTile from '../../src/components/tile/ImageTile';
import PromptPicker from '../../src/components/PromptPicker';
import Composer from '../../src/components/Composer';
import SaveTemplateDialog from '../../src/components/SaveTemplateDialog';
import { promptKeys } from '../../src/api/prompts';
import { historyKeys, type HistoryData } from '../../src/api/history';
import { useHistory } from '../../src/hooks/useHistory';
import { APP_VIEW_UNSORTED, initialAtelierState, useAtelierStore } from '../../src/store/atelier';
import ModerationNotice from '../../src/components/ModerationNotice';
import FailedTile from '../../src/components/tile/FailedTile';
import Toast from '../../src/components/Toast';
import { useTooltipDismiss } from '../../src/hooks/useTooltipDismiss';
import { useKeyboard } from '../../src/hooks/useKeyboard';
import { readSseFrames } from '../../src/api/sse';
// Production's global stylesheet (it imports tokens.css itself): reset,
// box-sizing, typography, .srOnly and the data-tip primitive. Importing only
// the tokens left every overlay's geometry and pixels unlike production.
import '../../src/styles/global.css';

const BATCH: Batch = {
  id: 'batch-1',
  prompt: 'harness batch',
  ratio: '1:1',
  modelId: 'gpt-image-2.5-sunburst',
  modelLabel: 'GPT Image',
  createdAt: 1,
  collectionId: null,
  pinned: false,
  status: 'done',
  tiles: [],
};

function ModerationCase() {
  const [input, setInput] = useState('My original creative brief');
  const announce = async (moderation: GptModerationNotice) => {
    const frame = `event: error\ndata: ${JSON.stringify({ message: 'Content check', moderation })}\n\n`;
    const body = new Response(frame).body;
    if (body) for await (const _frame of readSseFrames(body)) { /* Exercise the real event-to-notice path. */ }
  };
  return (
    <main style={{ maxWidth: 720, margin: '32px auto', padding: 20, fontFamily: 'var(--sans)', color: 'var(--ink)' }}>
      <h1>Atelier</h1>
      <label htmlFor="moderation-input">Your brief</label>
      <textarea id="moderation-input" value={input} onChange={(event) => { setInput(event.target.value); }} style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginBlock: 16 }} />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <button type="button" onClick={() => { void announce({ reason: 'sexual-age', categories: ['nudity'], target: 'text', modelLabel: 'GPT-6.1 Sol' }); }}>Preview nudity block</button>
        <button type="button" onClick={() => { void announce({ reason: 'sexual-age', categories: ['sexual-age'], target: 'text' }); }}>Preview age block</button>
        <button type="button" onClick={() => { void announce({ reason: 'graphic-violence', target: 'image' }); }}>Preview violence block</button>
        <button type="button" onClick={() => { void announce({ reason: 'sexual-age-and-violence', categories: ['nudity', 'sexual-age', 'graphic-violence'], target: 'text' }); }}>Preview all reasons</button>
        <button type="button" onClick={() => { void announce({ reason: 'unavailable', target: 'image' }); }}>Preview unavailable check</button>
      </div>
      <div style={{ maxWidth: 360 }}>
        <FailedTile tile={{ id: 'blocked', seed: 1, status: 'failed', completedAt: 1, error: 'content-policy violation', moderation: { reason: 'graphic-violence', target: 'image' } }} aspectRatio="16 / 9" onDismiss={() => undefined} onRetry={() => undefined} />
      </div>
      <ModerationNotice />
    </main>
  );
}

function DialogCase() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" id="background" onClick={() => { setOpen(true); }}>background + open</button>
      <button type="button" id="background-2">background 2</button>
      <DialogShell open={open} onCancel={() => { setOpen(false); }} label="Harness dialog">
        <div>
          <button type="button" id="first">first</button>
          <input id="middle" aria-label="middle" />
          <button type="button" id="last">last</button>
        </div>
      </DialogShell>
    </>
  );
}

function TallDialogCase() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => { setOpen(true); }}>Open tall dialog</button>
      <DialogShell open={open} onCancel={() => { setOpen(false); }} label="Tall dialog">
        <div className={dialogStyles.dialog}>
          <div className={dialogStyles.handle} aria-hidden="true" />
          <h2 className={dialogStyles.title}>A longer form</h2>
          <p className={dialogStyles.body}>Every field and the final action remain reachable in a short viewport.</p>
          {Array.from({ length: 8 }, (_, index) => (
            <label key={index} className={dialogStyles.inputRow}>
              <input className={dialogStyles.input} aria-label={`Field ${index + 1}`} placeholder={`Field ${index + 1}`} />
            </label>
          ))}
          <div className={dialogStyles.actions}>
            <button type="button" onClick={() => { setOpen(false); }}>Cancel</button>
            <div className={dialogStyles.actionsRight}>
              <button type="button" onClick={() => { setOpen(false); }}>Finish</button>
            </div>
          </div>
        </div>
      </DialogShell>
    </>
  );
}

/* Every optional image action on. `?width=` sets the tile column (default
   220px, the grid's narrowest `--tile-min`): `phone` fills a phone column, a
   number is a column width in px. `?aspect=16:9` (or any `w:h`) sets the
   tile ratio; default 1:1. */
function TileActionsCase() {
  const tile = EDIT_BATCH.tiles[0];
  if (tile?.status !== 'done') return <></>;
  const params = new URLSearchParams(window.location.search);
  const widthParam = params.get('width');
  const width = widthParam === 'phone'
    ? 'calc(100vw - 32px)'
    : widthParam && Number.isFinite(Number(widthParam)) ? Number(widthParam) : 220;
  const [ratioW = '1', ratioH = '1'] = (params.get('aspect') ?? '1:1').split(':');
  return (
    <main style={{ width, margin: '24px auto' }}>
      <ImageTile
        tile={tile}
        index={0}
        ratio={`${ratioW}:${ratioH}`}
        aspectRatio={`${ratioW} / ${ratioH}`}
        canEdit
        canAnimate
        canTellStory
        canCreateCard
        onOpen={() => undefined}
        onDownload={() => undefined}
        onDelete={() => undefined}
        onEdit={() => Promise.resolve(true)}
        onAnimate={() => Promise.resolve(true)}
        onTellStory={() => Promise.resolve(true)}
        onCreateCard={() => Promise.resolve(true)}
      />
    </main>
  );
}

function MenuCase() {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('none');
  return (
    <>
      <button type="button" id="outside">outside</button>
      <button type="button" id="trigger" ref={anchorRef} onClick={() => { setOpen((v) => !v); }}>more</button>
      <output id="picked">{picked}</output>
      <BatchOverflowMenu
        batch={BATCH}
        anchorRef={anchorRef}
        open={open}
        promptsEnabled
        readOnlyActions={false}
        onSelect={(action) => { setPicked(action); setOpen(false); }}
        onClose={() => { setOpen(false); }}
      />
    </>
  );
}

const MODEL: Model = {
  id: 'gpt-image-2.5-sunburst',
  name: 'GPT Image',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'slow',
  supportedRatios: ['1:1'],
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
  pool: 'shared',
  supportsReferenceImages: true,
};

const EDIT_BATCH: Batch = {
  ...BATCH,
  tiles: [{
    id: 'edit-tile',
    status: 'done',
    url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"%3E%3Crect width="800" height="800" fill="%236e8b74"/%3E%3Ccircle cx="400" cy="350" r="190" fill="%23d7c9a6"/%3E%3C/svg%3E',
    ext: 'png',
    mime: 'image/png',
    seed: 1,
    completedAt: 1,
  }],
};

function EditActionsCase() {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const tile = EDIT_BATCH.tiles[0];
  if (tile?.status !== 'done') return <></>;

  return (
    <>
      <main style={{ width: 'min(420px, calc(100vw - 32px))', margin: '32px auto' }}>
        <ImageTile
          tile={tile}
          index={0}
          ratio="1:1"
          aspectRatio="1 / 1"
          canEdit
          onOpen={() => { setLightboxOpen(true); }}
          onDownload={() => undefined}
          onDelete={() => undefined}
          onEdit={() => Promise.resolve(true)}
        />
      </main>
      {lightboxOpen && (
        <Lightbox
          batch={EDIT_BATCH}
          modelById={new Map([[MODEL.id, MODEL]])}
          triggerKey={tile.id}
          deleteVariant="archive"
          onClose={() => { setLightboxOpen(false); }}
          onDownload={() => undefined}
          onDelete={() => undefined}
        />
      )}
    </>
  );
}

// `n` batches in FEED order (what Canvas receives): oldest first, newest last.
function feedBatches(count: number, startAt = 0): Batch[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `batch-${startAt + i}`,
    prompt: `Prompt ${startAt + i}`,
    ratio: '1:1' as const,
    modelId: MODEL.id,
    modelLabel: MODEL.name,
    createdAt: startAt + i + 1,
    collectionId: null,
    pinned: false,
    status: 'done' as const,
    tiles: [{
      id: `tile-${startAt + i}`,
      status: 'done' as const,
      url: '/e2e/harness/index.html',
      ext: 'png' as const,
      mime: 'image/png' as const,
      seed: i,
      completedAt: startAt + i + 1,
    }],
  }));
}

/* Canvas alone, with the composer's height reserved below it, so the feed specs
   can assert landing position, append direction and reader stability. `seed`
   sets how many batches exist; "queue" appends one, standing in for an SSE
   batch event. */
function FeedCase() {
  const params = new URLSearchParams(window.location.search);
  const seed = Number(params.get('seed') ?? '30');
  const [batches, setBatches] = useState(() => feedBatches(seed, 100));
  const [olderLoaded, setOlderLoaded] = useState(0);
  const modelById = new Map([[MODEL.id, MODEL]]);
  return (
    // The left inset stands in for the sidebar rail. Tile height follows column
    // width, so a full-viewport canvas renders taller rows than production and
    // would misrepresent how close estimateBatchHeight actually is.
    <div style={{ position: 'fixed', inset: 0, paddingLeft: 248, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Canvas
          batches={batches}
          modelById={modelById}
          collections={[]}
          activeView={APP_VIEW_UNSORTED}
          hasNextPage={false}
          isFetchingNextPage={false}
          onLoadMore={() => undefined}
          onBatchAction={() => undefined}
          promptsEnabled={false}
          onTileAction={() => undefined}
          onOpenTile={() => undefined}
          q=""
        />
      </div>
      <div style={{ height: 120, borderTop: '1px solid #333', display: 'flex', alignItems: 'center', padding: '0 16px' }}>
        <button
          type="button"
          id="queue"
          onClick={() => { setBatches((current) => [...current, ...feedBatches(1, 100 + current.length)]); }}
        >
          queue one
        </button>
        <button
          type="button"
          id="load-older"
          onClick={() => {
            // Older history lands ABOVE the feed, the way an older page does.
            const next = olderLoaded + 1;
            setOlderLoaded(next);
            setBatches((current) => [...feedBatches(5, 100 - next * 5), ...current]);
          }}
        >
          load older
        </button>
      </div>
    </div>
  );
}

/* The phone shell the feed actually lives in: the composer FLOATS over the
   scroller (it does not take flow space), and publishes its distance from the
   viewport bottom as `--composer-top` — which is the only thing telling the
   canvas how much bottom room to reserve. FeedCase's in-flow footer cannot
   reproduce anything about content trapped behind the composer, so the phone
   specs need this shell. The newest batch is a 9:16 clip, the shape that
   pushes a tile's action row furthest down, unless `ratio=1:1` asks for a
   square one. */
function PhoneFeedCase() {
  const params = new URLSearchParams(window.location.search);
  const seed = Number(params.get('seed') ?? '4');
  const composerHeight = Number(params.get('composer') ?? '150');
  const newestRatio = params.get('ratio') === '1:1' ? '1:1' as const : '9:16' as const;
  const [batches, setBatches] = useState(() => {
    const feed = feedBatches(seed, 100);
    const last = feed[feed.length - 1];
    if (last) feed[feed.length - 1] = { ...last, ratio: newestRatio };
    return feed;
  });
  const modelById = new Map([[MODEL.id, MODEL]]);
  document.documentElement.style.setProperty('--composer-top', `${composerHeight}px`);
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Canvas
          batches={batches}
          modelById={modelById}
          collections={[]}
          activeView={APP_VIEW_UNSORTED}
          hasNextPage={false}
          isFetchingNextPage={false}
          onLoadMore={() => undefined}
          onBatchAction={() => undefined}
          promptsEnabled={false}
          onTileAction={() => undefined}
          onOpenTile={() => undefined}
          q=""
        />
      </div>
      <div
        id="composer"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: composerHeight,
          background: '#101010',
          borderTop: '1px solid #333',
        }}
      >
        <button
          type="button"
          id="queue"
          onClick={() => { setBatches((current) => [...current, ...feedBatches(1, 100 + current.length)]); }}
        >
          queue one
        </button>
      </div>
    </div>
  );
}

/* PromptPicker on a phone: the picker is a bottom sheet and each axis opens its
   own sheet portalled to <body>, stacked over the picker's backdrop. The specs
   assert that pinning a value inside that nested sheet leaves the picker open. */
const PROMPT_LIBRARY = {
  templates: [{
    id: 'tpl-1',
    name: 'Harness template',
    body: 'a {{var::mood}} portrait in {{var::place}}',
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  }],
  variableLists: [
    {
      id: 'list-mood',
      name: 'mood',
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      options: ['serene', 'brooding', 'playful'].map((value, i) => ({
        id: `mood-${i}`, listId: 'list-mood', value, tagIds: [], sortOrder: i, weight: 1,
      })),
    },
    {
      id: 'list-place',
      name: 'place',
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
      options: ['a rooftop', 'a stairwell', 'a greenhouse'].map((value, i) => ({
        id: `place-${i}`, listId: 'list-place', value, tagIds: [], sortOrder: i, weight: 1,
      })),
    },
  ],
  dimensions: [],
};

function PromptPickerCase() {
  const [open, setOpen] = useState(true);
  // App-level chrome the picker relies on in production: the single global
  // Toast (queue-clear Undo) and the delegated tooltip lifecycle.
  useTooltipDismiss();
  useKeyboard(() => undefined);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <button type="button" id="reopen" onClick={() => { setOpen(true); }}>open picker</button>
      <output id="picker-state">{open ? 'open' : 'closed'}</output>
      <PromptPicker
        open={open}
        onClose={() => { setOpen(false); }}
        modelOptions={[{ value: MODEL.id, label: MODEL.name }]}
        modelId={MODEL.id}
      />
      <Toast />
    </div>
  );
}

/* The character-card dialog with its card-kind picker; `#card-submitted`
   echoes the last submit as `kind:direction`. */
function CharacterCardCase() {
  const [submitted, setSubmitted] = useState('');
  return (
    <>
      <output id="card-submitted">{submitted}</output>
      <CharacterCardDialog
        initial={{ direction: '', kind: 'subject' }}
        onSubmit={(direction, kind) => { setSubmitted(`${kind}:${direction}`); }}
        onCancel={() => undefined}
      />
    </>
  );
}

const I2V_MODEL: Model = {
  id: 'minimax-h3-i2v', name: 'MiniMax H3 I2V', backend: 'local', tag: 'video', latency: 'slow', pool: 'local',
  supportedRatios: ['16:9'], supportedDurations: [124, 243], defaultDuration: 124,
  supportsI2V: true, outputsVideo: true, concurrencyCapPerUser: 1, maxCountPerBatch: 1,
};
const I2V_MODELS = [I2V_MODEL];
const I2V_MODEL_MAP = new Map(I2V_MODELS.map((model) => [model.id, model]));

function FrontendI2VCase() {
  useKeyboard(() => undefined);
  const draft = useAtelierStore((state) => state.draft);
  const setDraft = useAtelierStore((state) => state.setDraft);
  return (
    <main>
      <h1>Composer keyboard regression</h1>
      <Composer models={I2V_MODELS} modelById={I2V_MODEL_MAP} prompt={draft.prompt} modelId={I2V_MODEL.id}
        ratio="16:9" count={1} durationFrames={124}
        onPromptChange={(prompt) => { setDraft({ prompt }); }} onModelChange={() => undefined}
        onRatioChange={() => undefined} onDurationChange={() => undefined} onCountChange={() => undefined} onSubmit={() => undefined} />
    </main>
  );
}

function FrontendSaveTemplateCase() {
  useKeyboard(() => undefined);
  return (
    <main>
      <h1>Template input regression</h1>
      <button type="button" onClick={() => { useAtelierStore.getState().openSaveTemplate('A fox near a pond'); }}>Open save template</button>
      <SaveTemplateDialog />
    </main>
  );
}

const REFRESH_DEEP_ID = '00000000-0000-4000-8000-000000000020';

function seedHistoryRefresh(queryClient: QueryClient): void {
  const now = Date.now();
  const data: HistoryData = {
    pages: Array.from({ length: 20 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, '0');
      const active = index === 19;
      const batch: Batch = {
        ...BATCH,
        id: `00000000-0000-4000-8000-${suffix}`,
        prompt: `Polling page ${String(index + 1)}`,
        createdAt: now - index * 1000,
        startedAt: now,
        status: active ? 'running' : 'done',
        tiles: [active
          ? { id: `00000000-0000-4000-9000-${suffix}`, seed: 1, status: 'loading' }
          : { id: `00000000-0000-4000-9000-${suffix}`, seed: 1, status: 'done', url: '/img/polling-complete.png', ext: 'png', mime: 'image/png', completedAt: now }],
      };
      return { items: [batch], nextCursor: index === 19 ? null : `cursor-${String(index + 1)}` };
    }),
    pageParams: Array.from({ length: 20 }, (_, index) => index === 0 ? null : `cursor-${String(index)}`),
  };
  queryClient.setQueryData(historyKeys.list(), data, { updatedAt: now });
}

function FrontendHistoryRefreshCase() {
  const history = useHistory();
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryData<HistoryData>(historyKeys.list());
  const deep = history.batches.find((batch) => batch.id === REFRESH_DEEP_ID);
  return (
    <main>
      <h1>Automatic history refresh regression</h1>
      <output data-testid="history-refresh-state" data-batch={JSON.stringify(deep)}>{history.isError ? 'error' : deep?.tiles[0]?.status ?? 'missing'}</output>
      {history.isError && <button type="button" onClick={() => { void history.refetch(); }}>Retry active history</button>}
      <output data-testid="history-refresh-pagination">{JSON.stringify({
        pageCount: cache?.pages.length,
        deepPage: cache?.pages.findIndex((page) => page.items.some((batch) => batch.id === REFRESH_DEEP_ID)),
        cursors: cache?.pages.map((page) => page.nextCursor),
        pageParams: cache?.pageParams,
      })}</output>
    </main>
  );
}

const kase = new URLSearchParams(window.location.search).get('case');
const root = document.getElementById('harness');
const CASES: Record<string, () => React.JSX.Element> = {
  'tall-dialog': TallDialogCase,
  'tile-actions': TileActionsCase,
  moderation: ModerationCase,
  menu: MenuCase,
  feed: FeedCase,
  'phone-feed': PhoneFeedCase,
  picker: PromptPickerCase,
  edit: EditActionsCase,
  'character-card': CharacterCardCase,
  'frontend-i2v': FrontendI2VCase,
  'frontend-save-template': FrontendSaveTemplateCase,
  'frontend-history-refresh': FrontendHistoryRefreshCase,
};
const Case = (kase === null ? undefined : CASES[kase]) ?? DialogCase;
const NEEDS_QUERY_CLIENT = new Set(['feed', 'phone-feed', 'picker', 'edit', 'frontend-i2v', 'frontend-save-template', 'frontend-history-refresh']);
if (root) {
  const queryClient = new QueryClient();
  if (kase === 'frontend-i2v' || kase === 'frontend-save-template' || kase === 'frontend-history-refresh') useAtelierStore.setState(initialAtelierState, true);
  if (kase === 'frontend-history-refresh') seedHistoryRefresh(queryClient);
  if (kase === 'frontend-i2v') {
    useAtelierStore.getState().setDraft({ modelId: I2V_MODEL.id, motionPrompt: 'Slow camera orbit' });
    useAtelierStore.getState().setComposerExpanded(false);
  }
  // The picker reads its library through TanStack Query; seeding the cache is
  // how the harness stays API-free.
  if (kase === 'picker') queryClient.setQueryData(promptKeys.library(), PROMPT_LIBRARY);
  createRoot(root).render(
    kase !== null && NEEDS_QUERY_CLIENT.has(kase)
      ? <QueryClientProvider client={queryClient}><Case /></QueryClientProvider>
      : <Case />,
  );
}
