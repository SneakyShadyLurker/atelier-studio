import { useId, useState } from 'react';
import type { AdminModel, AdminProvider } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { useDeleteModel, useTextProviders, useTextRouting } from '../../hooks/useTextProviders';
import ConfirmDialog from '../ConfirmDialog';
import { ManagedViewHeader } from '../ManagedViewHeader';
import { ErrorState, LoadingState, StateView } from '../StateView';
import { I } from '../icons/I';
import btn from '../../styles/buttons.module.css';
import { removeModelCopy, type ModelAction } from './ModelRow';
import ProviderSection from './ProviderSection';
import RoutingPanel from './RoutingPanel';
import AddModelsDialog from './AddModelsDialog';
import AddProviderDialog from './AddProviderDialog';
import EditModelDialog from './EditModelDialog';
import EditProviderDialog from './EditProviderDialog';
import styles from './index.module.css';

const GUIDE_URL = 'https://github.com/SneakyShadyLurker/atelier-studio/blob/main/docs/connect-a-text-model.md';

/** Dialogs this view opens. 'test-model' is the model dialog with its test already running. */
export type TextModelsDialog =
  | { readonly kind: 'add-provider' }
  | { readonly kind: 'edit-provider'; readonly provider: AdminProvider }
  | { readonly kind: 'add-models'; readonly provider: AdminProvider }
  | { readonly kind: 'edit-model'; readonly provider: AdminProvider; readonly model: AdminModel }
  | { readonly kind: 'test-model'; readonly provider: AdminProvider; readonly model: AdminModel };

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
  // Every non-env provider carries this warning when the master key is unset.
  const byokMissing = providers?.some((provider) => provider.warnings.includes('byok-not-configured')) ?? false;
  const closeDialog = () => { setDialog(null); };

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
      {dialog?.kind === 'add-provider' && (
        <AddProviderDialog
          byokMissing={byokMissing}
          onClose={closeDialog}
          onSaved={(provider) => { setDialog({ kind: 'add-models', provider }); }}
        />
      )}
      {dialog?.kind === 'edit-provider' && (
        <EditProviderDialog provider={dialog.provider} imageLabel={imageLabel} onClose={closeDialog} />
      )}
      {dialog?.kind === 'add-models' && <AddModelsDialog provider={dialog.provider} onClose={closeDialog} />}
      {(dialog?.kind === 'edit-model' || dialog?.kind === 'test-model') && (
        <EditModelDialog
          key={`${dialog.kind}:${dialog.model.id}`}
          provider={dialog.provider}
          model={dialog.model}
          imageLabel={imageLabel}
          startTest={dialog.kind === 'test-model'}
          onClose={closeDialog}
        />
      )}
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
