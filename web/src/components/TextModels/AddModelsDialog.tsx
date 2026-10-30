import { useId, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminProvider, ListedModel, TextModelHints } from '@atelier/shared';
import { listAvailableModels, textAdminKeys, type NewModelBody } from '../../api/textProviders';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useAddModels } from '../../hooks/useTextProviders';
import { describeError } from '../../lib/errorCopy';
import { isImeComposing } from '../../lib/ime';
import { useAtelierStore } from '../../store/atelier';
import { DialogShell } from '../DialogShell';
import btn from '../../styles/buttons.module.css';
import dialogStyles from '../../styles/dialog.module.css';
import { describedBy } from './ProviderForm';
import { probeFailureCopy } from './TestReport';
import form from './AddProviderDialog.module.css';
import styles from './ModelDialogs.module.css';

const MODEL_ID_MAX = 200;

/** List hints as plain words: "image input · JSON · reasoning". */
export function hintWords(hints: TextModelHints | undefined): string {
  if (hints === undefined) return '';
  const words: string[] = [];
  if (hints.vision === true) words.push('image input');
  if (hints.structuredOutput !== undefined && hints.structuredOutput !== 'none') words.push('JSON');
  if (hints.reasoningLevels !== undefined && hints.reasoningLevels.length > 0) words.push('reasoning');
  return words.join(' · ');
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

interface AddModelsDialogProps {
  readonly provider: AdminProvider;
  readonly onClose: () => void;
}

export default function AddModelsDialog({ provider, onClose }: AddModelsDialogProps) {
  const titleId = useId();
  const manualId = useId();
  const manualErrorId = useId();
  const { closing, requestClose } = useExitTransition(onClose, true);
  const addToast = useAtelierStore((state) => state.addToast);
  const add = useAddModels();
  // A live upstream call under the shared limiter: once per open, no retry,
  // no refetch on focus.
  const listing = useQuery({
    queryKey: [...textAdminKeys.all(), 'available', provider.id],
    queryFn: () => listAvailableModels(provider.id),
    enabled: provider.listModels,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** Ids typed by hand, in the order entered. */
  const [manual, setManual] = useState<readonly string[]>([]);
  const [manualText, setManualText] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const busy = add.isPending;
  const added = new Set(provider.models.map((model) => model.modelId));
  const listed: readonly ListedModel[] = listing.data?.models ?? [];
  const listedIds = new Set(listed.map((model) => model.id));
  const manualOnly = !provider.listModels || listing.data?.listUnsupported === true;
  const query = search.trim().toLowerCase();
  const shown = query === '' ? listed : listed.filter((model) => model.id.toLowerCase().includes(query));
  const count = selected.size;

  const toggle = (id: string, on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    setSaveError(null);
  };

  const addManual = () => {
    const id = manualText.trim();
    if (id === '') return;
    if (id.length > MODEL_ID_MAX) {
      setManualError(`A model id has at most ${MODEL_ID_MAX} characters.`);
      return;
    }
    if (added.has(id)) {
      setManualError(`${id} is already added.`);
      return;
    }
    if (!listedIds.has(id) && !manual.includes(id)) setManual((previous) => [...previous, id]);
    toggle(id, true);
    setManualText('');
    setManualError(null);
  };

  const onManualKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || isImeComposing(event)) return;
    event.preventDefault();
    addManual();
  };

  const submit = () => {
    if (busy || closing || count === 0) return;
    const hintsById = new Map(listed.map((model) => [model.id, model.hints] as const));
    // Listed order first, then the typed ids; the hints let rows start with them.
    const ids = [...listed.map((model) => model.id), ...manual].filter((id) => selected.has(id));
    const models: NewModelBody[] = ids.map((modelId) => {
      const hints = hintsById.get(modelId);
      return hints === undefined ? { modelId } : { modelId, hints };
    });
    setSaveError(null);
    add.mutateAsync({ providerId: provider.id, models })
      .then((rows) => {
        addToast(`Added ${plural(rows.length, 'model')}`);
        onClose();
      })
      .catch((error: unknown) => { setSaveError(describeError(error, 'Couldn’t add the models. Try again.')); });
  };

  const option = (id: string, hints: TextModelHints | undefined) => {
    const isAdded = added.has(id);
    const words = isAdded ? 'Added' : hintWords(hints);
    return (
      <li key={id} className={styles.modelItem}>
        <label className={styles.modelOption}>
          <input
            type="checkbox"
            checked={isAdded || selected.has(id)}
            disabled={isAdded || busy}
            onChange={(event) => { toggle(id, event.currentTarget.checked); }}
          />
          <span className={styles.modelId}>{id}</span>
          {words !== '' && <span className={styles.hints}>{words}</span>}
        </label>
      </li>
    );
  };

  let listBlock;
  if (!provider.listModels) {
    listBlock = <p className={styles.empty}>This provider’s model list is turned off. Enter the model ids yourself.</p>;
  } else if (listing.isPending) {
    listBlock = <p className={styles.empty} role="status">Loading the model list…</p>;
  } else if (listing.isError) {
    listBlock = (
      <div role="alert" className={`${form.report} ${form.reportFail}`}>
        <p className={form.reportLine}>{probeFailureCopy(listing.error, 'Couldn’t load the model list.')}</p>
        <button type="button" className={form.linkBtn} onClick={() => { void listing.refetch(); }}>Try again</button>
      </div>
    );
  } else if (manualOnly) {
    listBlock = (
      <p className={styles.empty}>
        This server doesn’t list its models. Enter the ids yourself; you can turn the model list off in the provider’s settings.
      </p>
    );
  } else {
    listBlock = (
      <>
        <div className={styles.toolbar}>
          <div className={form.inputBox}>
            <input
              type="search"
              className={form.monoInput}
              aria-label="Search models"
              placeholder="Search models…"
              autoComplete="off"
              value={search}
              onChange={(event) => { setSearch(event.currentTarget.value); }}
            />
          </div>
          <span className={styles.count}>{`${listed.length} listed, ${count} selected`}</span>
        </div>
        {shown.length === 0 && manual.length === 0
          ? <p className={styles.empty}>{listed.length === 0 ? 'The server listed no models.' : 'No listed model matches.'}</p>
          : (
            <ul className={styles.modelList} aria-label="Models">
              {manual.map((id) => option(id, undefined))}
              {shown.map((model) => option(model.id, model.hints))}
            </ul>
          )}
      </>
    );
  }

  return (
    <DialogShell open onCancel={() => { if (!busy) requestClose(); }} closing={closing} busy={busy} labelledBy={titleId}>
      <div className={`${dialogStyles.dialog} ${styles.dialog}`}>
        <div className={dialogStyles.handle} aria-hidden="true" />
        <h2 id={titleId} className={dialogStyles.title}>{`Add models from ${provider.name}`}</h2>

        {listBlock}

        {/* Typed ids outside a list still show, so the count is never hidden. */}
        {(manualOnly || listing.isError) && manual.length > 0 && (
          <ul className={styles.modelList} aria-label="Models">{manual.map((id) => option(id, undefined))}</ul>
        )}

        <div className={form.field}>
          <label htmlFor={manualId} className={form.fieldLabel}>Not listed? Enter a model id</label>
          <div className={styles.manualRow}>
            <div className={form.inputBox}>
              <input
                id={manualId}
                className={form.monoInput}
                value={manualText}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-invalid={manualError === null ? undefined : true}
                aria-describedby={describedBy(manualError !== null && manualErrorId)}
                onChange={(event) => { setManualText(event.currentTarget.value); setManualError(null); }}
                onKeyDown={onManualKeyDown}
              />
            </div>
            <button type="button" className={btn.secondary} onClick={addManual} disabled={busy || manualText.trim() === ''}>Add</button>
          </div>
          {manualError !== null && <p id={manualErrorId} className={form.fieldError}>{manualError}</p>}
        </div>

        {saveError !== null && <p role="alert" className={form.fieldError}>{saveError}</p>}

        <div className={`${dialogStyles.actions} ${form.actions}`}>
          <div className={dialogStyles.actionsRight}>
            <button type="button" className={btn.secondary} onClick={() => { if (!busy) requestClose(); }} disabled={busy}>Cancel</button>
            <button type="button" className={btn.primary} onClick={submit} disabled={busy || count === 0}>
              {busy ? 'Adding…' : count === 0 ? 'Add models' : `Add ${plural(count, 'model')}`}
            </button>
          </div>
        </div>
        {busy && <div className={dialogStyles.progressBar} aria-hidden="true" />}
      </div>
    </DialogShell>
  );
}
