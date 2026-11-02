/*
 * Native anchor positioning harness for the real-browser lane
 * (web/e2e/native-anchors.spec.ts). Production owners only, mounted the way
 * App mounts them: production global.css, the global keyboard dispatcher, the
 * delegated tooltip lifecycle and the single Toast.
 *
 *   ?case=feed      the virtualized Canvas feed: repeated batch headers, the
 *                   More menu, the Move popover (from More and from the
 *                   collection chip) and the BatchPrompt card, in the real
 *                   contain:strict scroller.
 *   ?case=composer  the Composer with its chip menus and the Prompt Picker
 *                   (anchored to the Composer) with its axis menus.
 *   ?case=edges     ChipSelect, BatchOverflowMenu, BatchPrompt and a long
 *                   data-tip host pinned to one viewport corner
 *                   (&at=top-left|top-right|bottom-left|bottom-right, and
 *                   &place= for the tip) to drive flips, mirroring and edge
 *                   clearance.
 *   ?case=tips      data-tip hosts: every placement, a clipping box, a masked
 *                   box, glass tile actions (transformed, filtered hosts), a
 *                   nested host, a chip menu option, a long label, a scroller,
 *                   and a native modal dialog. No Composer, so the toast stack
 *                   shows its nonanchored fallback.
 *   ?case=editor    the production TemplateEditor with its inline name field.
 *   ?case=settings  the production text-model settings near the window top.
 *   &theme=dark     dark tokens.
 *
 * window.atelierHarness.toast(text) raises an actionable toast with an Undo
 * through the production store; window.atelierHarness.undos counts its
 * activations; documentEscapes counts Escapes that reached the document
 * unconsumed. In the edges case removeEdgeMore() and removeEdgeTip() unmount
 * the More trigger and the tip host synchronously, and openEdgeMenu() opens
 * the More menu (with or without its trigger). Dev-server only, like
 * index.html: nothing here reaches dist.
 */
import type { Batch, Collection, CollectionsResponse, Model, TextModelsResponse } from '@atelier/shared';
import { TEXT_TASKS } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { collectionKeys } from '../../src/api/collections';
import { promptKeys } from '../../src/api/prompts';
import { textModelKeys } from '../../src/api/textModels';
import BatchPrompt from '../../src/components/Batch/BatchPrompt';
import BatchOverflowMenu from '../../src/components/BatchOverflowMenu';
import Canvas from '../../src/components/Canvas';
import Composer from '../../src/components/Composer';
import ChipSelect, { type ChipSelectOption } from '../../src/components/Composer/ChipSelect';
import { DialogShell } from '../../src/components/DialogShell';
import TemplateEditor from '../../src/components/PromptManager/TemplateEditor';
import SettingsPanel from '../../src/components/PromptManager/SettingsPanel';
import ImageTile from '../../src/components/tile/ImageTile';
import Toast from '../../src/components/Toast';
import { useKeyboard } from '../../src/hooks/useKeyboard';
import { useTooltipDismiss } from '../../src/hooks/useTooltipDismiss';
import { APP_VIEW_UNSORTED, useAtelierStore, type Count } from '../../src/store/atelier';
import buttons from '../../src/styles/buttons.module.css';
import '../../src/styles/global.css';

const params = new URLSearchParams(window.location.search);
if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

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
const MODEL_BY_ID = new Map([[MODEL.id, MODEL]]);

const COLLECTIONS: readonly Collection[] = [
  { id: 'collection-logo', name: 'Logo concepts', count: 3, archivedCount: 0, createdAt: 1 },
  { id: 'collection-studio', name: 'Studio refs', count: 1, archivedCount: 0, createdAt: 2 },
];

const COLLECTIONS_RESPONSE: CollectionsResponse = {
  items: COLLECTIONS,
  summary: { totalCount: 4, pinnedCount: 0, unsortedCount: 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
};

const IMAGE = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"%3E%3Crect width="800" height="800" fill="%236e8b74"/%3E%3C/svg%3E';

const LONG_PROMPT = 'An editorial portrait of a lighthouse keeper at dusk, salt-stained wool coat, '
  + 'lantern light raking across weathered skin, fog rolling in over basalt cliffs, shot on medium format, '
  + 'muted teal and amber palette, shallow depth of field, quiet and contemplative mood';

// Feed order (what Canvas receives): oldest first, newest last. Every other
// batch sits in a collection so its meta row carries the collection chip.
function feedBatches(count: number): Batch[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `batch-${String(i)}`,
    prompt: `${String(i)} · ${LONG_PROMPT}`,
    ratio: '1:1' as const,
    modelId: MODEL.id,
    modelLabel: MODEL.name,
    createdAt: i + 1,
    collectionId: i % 2 === 0 ? 'collection-logo' : null,
    pinned: false,
    status: 'done' as const,
    tiles: [{
      id: `tile-${String(i)}`,
      status: 'done' as const,
      url: IMAGE,
      ext: 'png' as const,
      mime: 'image/png' as const,
      seed: i,
      completedAt: i + 1,
    }],
  }));
}

const BATCH = (() => {
  const batch = feedBatches(1)[0];
  if (!batch) throw new Error('Anchor harness requires its seed batch');
  return batch;
})();

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
      options: ['serene', 'brooding', 'playful', 'wistful', 'stern', 'radiant', 'weary', 'electric'].map((value, i) => ({
        id: `mood-${String(i)}`, listId: 'list-mood', value, tagIds: [], sortOrder: i, weight: 1,
      })),
    },
    {
      id: 'list-place',
      name: 'place',
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
      options: ['a rooftop', 'a stairwell', 'a greenhouse'].map((value, i) => ({
        id: `place-${String(i)}`, listId: 'list-place', value, tagIds: [], sortOrder: i, weight: 1,
      })),
    },
  ],
  dimensions: [],
};

const harness = {
  undos: 0,
  documentEscapes: 0,
  toast(text: string) {
    useAtelierStore.getState().addToast(text, 'soft', 60_000, {
      label: 'Undo',
      onClick: () => { harness.undos += 1; },
    });
  },
};
Object.assign(window, { atelierHarness: harness });

// App-level chrome every case relies on in production.
function AppChrome() {
  useTooltipDismiss();
  useKeyboard([]);
  // An Escape no capture-phase owner consumed reaches document-level owners
  // (useModalChrome, the keyboard registry): counted here, first among them.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) harness.documentEscapes += 1;
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); };
  }, []);
  return <Toast />;
}

function FeedCase() {
  const [batches] = useState(() => feedBatches(Number(params.get('seed') ?? '24')));
  return (
    <div style={{ position: 'absolute', inset: 0, paddingLeft: 248, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Canvas
          batches={batches}
          modelById={MODEL_BY_ID}
          collections={COLLECTIONS}
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
      <AppChrome />
    </div>
  );
}

function ComposerCase() {
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState<Count>(1);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Composer
        models={[MODEL]}
        modelById={MODEL_BY_ID}
        prompt={prompt}
        modelId={MODEL.id}
        ratio="1:1"
        count={count}
        promptsEnabled
        onPromptChange={setPrompt}
        onModelChange={() => undefined}
        onRatioChange={() => undefined}
        onDurationChange={() => undefined}
        onCountChange={setCount}
        onSubmit={() => undefined}
      />
      <AppChrome />
    </div>
  );
}

const TALL_OPTIONS: readonly ChipSelectOption<string>[] = Array.from({ length: 30 }, (_, i) => ({
  value: `option-${String(i)}`,
  label: `Option ${String(i + 1)} with a deliberately long label`,
}));

const EDGE_TIP = 'A deliberately long tooltip label that has to stay inside the window';

function EdgesCase() {
  const at = params.get('at') ?? 'top-left';
  const place = params.get('place');
  const [value, setValue] = useState('option-0');
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreMounted, setMoreMounted] = useState(true);
  const [tipMounted, setTipMounted] = useState(true);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  // Synchronous, so a browser check can sample the very next frames.
  useEffect(() => {
    Object.assign(harness, {
      removeEdgeMore() { flushSync(() => { setMoreMounted(false); }); },
      removeEdgeTip() { flushSync(() => { setTipMounted(false); }); },
      openEdgeMenu() { flushSync(() => { setMenuOpen(true); }); },
    });
  }, []);
  const corner: CSSProperties = {
    position: 'fixed',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    ...(at.startsWith('top') ? { top: 16 } : { bottom: 16 }),
    ...(at.endsWith('left') ? { left: 16 } : { right: 16, flexDirection: 'row-reverse' }),
  };
  return (
    <>
      <div id="corner" style={corner}>
        <ChipSelect ariaLabel="Edge choice" valueDisplay={value} options={TALL_OPTIONS} value={value} onChange={setValue} />
        {moreMounted ? (
          <button
            ref={menuRef}
            id="edge-more"
            type="button"
            className={buttons.iconAction}
            data-size="28"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => { setMenuOpen((open) => !open); }}
          >
            …
          </button>
        ) : null}
        {tipMounted ? (
          <button
            id="edge-tip"
            type="button"
            className={buttons.iconAction}
            data-size="28"
            aria-label="Edge tip"
            data-tip={EDGE_TIP}
            {...(place ? { 'data-tip-place': place } : {})}
          >
            ·
          </button>
        ) : null}
        <div style={{ width: 220 }}>
          <BatchPrompt prompt={params.has('longPrompt') ? LONG_PROMPT.repeat(24) : LONG_PROMPT} />
        </div>
      </div>
      <BatchOverflowMenu
        batch={BATCH}
        anchorRef={menuRef}
        open={menuOpen}
        promptsEnabled
        readOnlyActions={false}
        onSelect={() => { setMenuOpen(false); }}
        onClose={() => { setMenuOpen(false); }}
      />
      <AppChrome />
    </>
  );
}

const PLACES = ['', 'below', 'above-end', 'above-start', 'below-end', 'below-start'] as const;

const LONG_TIP = Array.from({ length: 12 }, () => 'a label far longer than any one line').join(' · ');

function TipsCase() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [model, setModel] = useState('one');
  const [presses, setPresses] = useState(0);
  const tile = BATCH.tiles[0];
  return (
    <main style={{ padding: '120px 160px', display: 'grid', gap: 48, color: 'var(--ink)' }}>
      <div style={{ display: 'flex', gap: 48 }}>
        {PLACES.map((place) => (
          <button
            key={place || 'default'}
            type="button"
            className={buttons.iconAction}
            data-size="28"
            aria-label={`Tip ${place || 'default'}`}
            data-tip={`Label ${place || 'default'}`}
            {...(place ? { 'data-tip-place': place } : {})}
          >
            ·
          </button>
        ))}
      </div>
      {/* A clipping box, and a masked one, around their hosts. */}
      <div style={{ display: 'flex', gap: 48 }}>
        <div id="clip" style={{ overflow: 'hidden', height: 40, display: 'flex', alignItems: 'center', border: '1px dashed var(--line)' }}>
          <button type="button" className={buttons.iconAction} data-size="28" aria-label="Clipped host" data-tip="Escapes the clip">·</button>
        </div>
        <div id="mask" style={{ height: 40, display: 'flex', alignItems: 'center', maskImage: 'linear-gradient(to bottom, transparent 0, black 14px, black calc(100% - 14px), transparent 100%)' }}>
          <button type="button" className={buttons.iconAction} data-size="28" aria-label="Masked host" data-tip="Escapes the mask">·</button>
        </div>
        {/* A press counter: a label click must never reach it. */}
        <button type="button" id="counter" tabIndex={0} aria-label="Press counter" data-tip="Counts presses" onClick={() => { setPresses((count) => count + 1); }}>
          {presses}
        </button>
        <button type="button" className={buttons.iconAction} data-size="28" aria-label="Long tip" data-tip={LONG_TIP}>·</button>
      </div>
      {/* A scroller with repeated hosts. */}
      <div id="scroller" style={{ overflowY: 'auto', height: 120, border: '1px dashed var(--line)' }}>
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} style={{ height: 40, display: 'flex', alignItems: 'center', paddingLeft: 12 }}>
            <button type="button" className={buttons.iconAction} data-size="28" aria-label={`Row ${String(i + 1)}`} data-tip={`Row ${String(i + 1)}`}>·</button>
          </div>
        ))}
      </div>
      {/* Nested hosts: the chip's own tip and its value span's. */}
      <div>
        <ChipSelect
          ariaLabel="Nested model"
          valueDisplay="Model value"
          valueTitle="Value label"
          tip="Chip label"
          options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two', title: 'Option label' }]}
          value={model}
          onChange={setModel}
        />
      </div>
      {/* Glass tile actions: each host is its own containing block. */}
      {tile?.status === 'done' ? (
        <div style={{ width: 260 }}>
          <ImageTile
            tile={tile}
            index={0}
            ratio="1:1"
            aspectRatio="1 / 1"
            onOpen={() => undefined}
            onDownload={() => undefined}
            onDelete={() => undefined}
          />
        </div>
      ) : null}
      <div>
        <button type="button" id="open-dialog" onClick={() => { setDialogOpen(true); }}>open dialog</button>
        <output id="dialog-state">{dialogOpen ? 'open' : 'closed'}</output>
      </div>
      <DialogShell open={dialogOpen} onCancel={() => { setDialogOpen(false); }} label="Tip dialog">
        <div style={{ padding: 48 }}>
          <button type="button" className={buttons.iconAction} data-size="28" aria-label="Dialog host" data-tip="Inside the dialog">·</button>
        </div>
      </DialogShell>
      <AppChrome />
    </main>
  );
}

// The production editor head: its inline name field, Enter/Escape blur and
// the disabled-state button tooltips beside it.
function EditorCase() {
  const template = PROMPT_LIBRARY.templates[0];
  return (
    <main style={{ padding: '120px 160px', color: 'var(--ink)' }}>
      {template ? <TemplateEditor template={template} variableLists={PROMPT_LIBRARY.variableLists} /> : null}
      <AppChrome />
    </main>
  );
}

// Two providers, one offline model and one fixed-effort model: every state
// the settings rows and their grouped menus can show.
const TEXT_MODELS: TextModelsResponse = {
  models: [
    { id: 'kimi', displayName: 'Kimi K3', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['low', 'high', 'max'], status: 'available' },
    { id: 'mimo', displayName: 'MiMo V2.6 Pro', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['none', 'high'], status: 'available' },
    { id: 'grok', displayName: 'Grok 4.7', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh'], status: 'available' },
    { id: 'gemini', displayName: 'Gemini 4 Argon', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['low', 'medium', 'high'], status: 'available' },
    { id: 'glm', displayName: 'GLM 5.3', providerName: 'CLIProxyAPI', vision: false, reasoningLevels: ['low', 'high', 'max'], status: 'offline' },
    { id: 'scout', displayName: 'Llama 4 Scout', providerName: 'Ollama on this Mac', vision: true, reasoningLevels: [], status: 'available' },
  ],
  tasks: TEXT_TASKS.map((task) => {
    if (task === 'ai-fill') return { task, pick: 'grok', effort: 'high', effectiveModelId: 'grok', pickState: 'active' };
    if (task === 'storytelling') return { task, pick: 'glm', effectiveModelId: 'kimi', pickState: 'offline' };
    if (task === 'list-draft') return { task, pick: 'scout', effectiveModelId: 'scout', pickState: 'active' };
    return { task, effectiveModelId: 'kimi' };
  }),
  defaults: { default: 'kimi', byTask: {} },
  writers: {},
};

function SettingsCase() {
  return (
    <main style={{ padding: '80px 24px', maxWidth: 1000, margin: 'auto' }}>
      <SettingsPanel />
      <AppChrome />
    </main>
  );
}

const CASES: Record<string, () => React.JSX.Element> = {
  feed: FeedCase,
  composer: ComposerCase,
  edges: EdgesCase,
  tips: TipsCase,
  editor: EditorCase,
  settings: SettingsCase,
};

const kase = params.get('case') ?? 'tips';
const Case = CASES[kase] ?? TipsCase;
const root = document.getElementById('harness');
if (root) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // TanStack Query cache seeding keeps every case API-free.
  queryClient.setQueryData(collectionKeys.list(), COLLECTIONS_RESPONSE);
  Object.assign(harness, {
    growCollections() {
      queryClient.setQueryData(collectionKeys.list(), {
        ...COLLECTIONS_RESPONSE,
        items: [...COLLECTIONS, ...Array.from({ length: 32 }, (_, index) => ({
          id: `extra-${String(index)}`, name: `Harness collection ${String(index)}`, count: 0, archivedCount: 0, createdAt: index + 3,
        }))],
      });
    },
  });
  queryClient.setQueryData(promptKeys.library(), PROMPT_LIBRARY);
  queryClient.setQueryData(textModelKeys.all(), TEXT_MODELS);
  createRoot(root).render(<StrictMode><QueryClientProvider client={queryClient}><Case /></QueryClientProvider></StrictMode>);
}
