import { useId, useState } from 'react';
import type { AdminModel, AdminProvider } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useDeleteModel, useTextProviders, useTextRouting } from '../../hooks/useTextProviders';
import ConfirmDialog from '../ConfirmDialog';
import { DialogShell } from '../DialogShell';
import { ManagedViewHeader } from '../ManagedViewHeader';
import { ErrorState, LoadingState, StateView } from '../StateView';
import { I } from '../icons/I';
import btn from '../../styles/buttons.module.css';
import dialogStyles from '../../styles/dialog.module.css';
import { removeModelCopy, type ModelAction } from './ModelRow';
import ProviderSection from './ProviderSection';
import RoutingPanel from './RoutingPanel';
import styles from './index.module.css';

const GUIDE_URL = 'https://github.com/SneakyShadyLurker/atelier-studio/blob/main/docs/connect-a-text-model.md';

/**
 * Dialogs this view opens. Task 15 renders 'add-provider' / 'edit-provider',
 * Task 16 'add-models' / 'edit-model' / 'test-model'; until then each opens
 * the placeholder below.
 */
export type TextModelsDialog =
  | { readonly kind: 'add-provider' }
  | { readonly kind: 'edit-provider'; readonly provider: AdminProvider }
  | { readonly kind: 'add-models'; readonly provider: AdminProvider }
  | { readonly kind: 'edit-model'; readonly provider: AdminProvider; readonly model: AdminModel }
  | { readonly kind: 'test-model'; readonly provider: AdminProvider; readonly model: AdminModel };

const DIALOG_TITLE: Record<TextModelsDialog['kind'], string> = {
  'add-provider': 'Add a provider',
  'edit-provider': 'Edit provider',
  'add-models': 'Add models',
  'edit-model': 'Edit model',
  'test-model': 'Test model',
};

// Placeholder until Tasks 15-16 replace each kind with its real dialog.
function PendingDialog({ dialog, onClose }: { dialog: TextModelsDialog; onClose: () => void }) {
  const titleId = useId();
  const { closing, requestClose } = useExitTransition(onClose, true);
  return (
    <DialogShell open onCancel={requestClose} closing={closing} labelledBy={titleId}>
      <div className={dialogStyles.dialog}>
        <div className={dialogStyles.handle} aria-hidden="true" />
        <h2 id={titleId} className={dialogStyles.title}>{DIALOG_TITLE[dialog.kind]}</h2>
        <p className={dialogStyles.body}>This form is not built yet.</p>
        <div className={dialogStyles.actions}>
          <div className={dialogStyles.actionsRight}>
            <button type="button" className={btn.secondary} onClick={requestClose}>Close</button>
          </div>
        </div>
      </div>
    </DialogShell>
  );
}

interface TextModelsProps {
  readonly onBack: () => void;
}

export default function TextModels({ onBack }: TextModelsProps) {
  const headingId = useId();
  const admin = useTextProviders();
  const routing = useTextRouting(admin.enabled);
  const deleteModel = useDeleteModel();
  const addToast = useAtelierStore((state) => state.addToast);
  const [dialog, setDialog] = useState<TextModelsDialog | null>(null);
  const [removing, setRemoving] = useState<{ provider: AdminProvider; model: AdminModel } | null>(null);

  const imageLabel = (id: string) => routing.data?.imageModels.find((image) => image.id === id)?.label ?? id;
  const addProvider = () => { setDialog({ kind: 'add-provider' }); };
  const providers = admin.data?.providers;

  const onModelAction = (provider: AdminProvider) => (model: AdminModel, action: ModelAction) => {
    if (action === 'edit') setDialog({ kind: 'edit-model', provider, model });
    else if (action === 'test') setDialog({ kind: 'test-model', provider, model });
    else setRemoving({ provider, model });
  };

  const confirmRemove = () => {
    if (removing === null) return;
    const { provider, model } = removing;
    setRemoving(null);
    deleteModel.mutateAsync({ providerId: provider.id, modelId: model.id })
      .then(() => { addToast(`Removed ${model.displayName}`); })
      .catch((error: unknown) => { addToast(describeError(error, `Couldn’t remove ${model.displayName}.`), 'error'); });
  };

  let content;
  if (admin.isLoading) {
    content = <LoadingState label="Loading text models…" />;
  } else if (admin.isError || (providers === undefined && !admin.gated)) {
    content = <ErrorState message="Couldn’t load the text models." onRetry={() => { void admin.refetch(); }} />;
  } else if (providers === undefined) {
    content = null;
  } else if (providers.length === 0) {
    content = (
      <StateView
        glyph={<I.chip width={22} height={22} />}
        title="No text model yet"
        body={(
          <>
            Connect a provider such as Ollama, LM Studio, OpenAI, Anthropic or OpenRouter, then add the models
            you want Atelier to write with.{' '}
            <a className={styles.guideLink} href={GUIDE_URL} target="_blank" rel="noopener noreferrer">Read the guide</a>
          </>
        )}
        action={{ label: 'Add provider', onClick: addProvider }}
      />
    );
  } else {
    content = (
      <div className={styles.body} data-zone="body">
        <RoutingPanel providers={providers} />
        {providers.map((provider) => (
          <ProviderSection
            key={provider.id}
            provider={provider}
            onEditProvider={() => { setDialog({ kind: 'edit-provider', provider }); }}
            onAddModels={() => { setDialog({ kind: 'add-models', provider }); }}
            onModelAction={onModelAction(provider)}
          />
        ))}
      </div>
    );
  }

  return (
    <section className={styles.view} aria-labelledby={headingId}>
      <div className={styles.head} data-zone="head">
        <ManagedViewHeader heading="Text models" headingId={headingId} label="TEXT MODELS" onBack={onBack}>
          <button className={btn.secondary} type="button" onClick={addProvider}>Add provider</button>
        </ManagedViewHeader>
      </div>
      {content}
      {dialog !== null && <PendingDialog dialog={dialog} onClose={() => { setDialog(null); }} />}
      {removing !== null && (
        <ConfirmDialog
          open
          danger
          title={`Remove ${removing.model.displayName}?`}
          body={removeModelCopy(removing.model.usage, imageLabel)}
          confirmLabel="Remove model"
          cancelLabel="Cancel"
          onConfirm={confirmRemove}
          onCancel={() => { setRemoving(null); }}
        />
      )}
    </section>
  );
}
