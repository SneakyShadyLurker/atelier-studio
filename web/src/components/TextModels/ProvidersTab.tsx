import { useState } from 'react';
import type { AdminModel, AdminProvider } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { useDeleteModel, useTextRouting } from '../../hooks/useTextProviders';
import ConfirmDialog from '../ConfirmDialog';
import { StateView } from '../StateView';
import { I } from '../icons/I';
import btn from '../../styles/buttons.module.css';
import { removeModelCopy, type ModelAction } from './ModelRow';
import ProviderSection from './ProviderSection';
import AddModelsDialog from './AddModelsDialog';
import AddProviderDialog from './AddProviderDialog';
import EditModelDialog from './EditModelDialog';
import EditProviderDialog from './EditProviderDialog';
import styles from './index.module.css';

const GUIDE_URL = 'https://github.com/SneakyShadyLurker/atelier-studio/blob/main/docs/connect-a-text-model.md';

/** Dialogs this tab opens. 'test-model' is the model dialog with its test already running. */
export type TextModelsDialog =
  | { readonly kind: 'add-provider' }
  | { readonly kind: 'edit-provider'; readonly provider: AdminProvider }
  | { readonly kind: 'add-models'; readonly provider: AdminProvider }
  | { readonly kind: 'edit-model'; readonly provider: AdminProvider; readonly model: AdminModel }
  | { readonly kind: 'test-model'; readonly provider: AdminProvider; readonly model: AdminModel };

interface ProvidersTabProps {
  /** The admin probe's last answer; a failed refetch keeps it. */
  readonly providers: readonly AdminProvider[];
}

/** The provider and model inventory with its dialogs (text admins only). */
export default function ProvidersTab({ providers }: ProvidersTabProps) {
  // Image-model labels only; a failed routing read falls back to the ids.
  const routing = useTextRouting();
  const deleteModel = useDeleteModel();
  const addToast = useAtelierStore((state) => state.addToast);
  const [dialog, setDialog] = useState<TextModelsDialog | null>(null);
  const [removing, setRemoving] = useState<{ provider: AdminProvider; model: AdminModel } | null>(null);

  const imageLabel = (id: string) => routing.data?.imageModels.find((image) => image.id === id)?.label ?? id;
  const addProvider = () => { setDialog({ kind: 'add-provider' }); };
  // Every non-env provider carries this warning when the master key is unset.
  const byokMissing = providers.some((provider) => provider.warnings.includes('byok-not-configured'));
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

  return (
    <>
      {providers.length === 0 ? (
        <StateView
          art="empty-text-models"
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
      ) : (
        <div className={styles.column}>
          <div className={styles.addRow}>
            <button className={btn.secondary} type="button" onClick={addProvider}>
              <I.plus aria-hidden="true" />
              Add provider
            </button>
          </div>
          {providers.map((provider) => (
            <ProviderSection
              key={provider.id}
              provider={provider}
              imageLabel={imageLabel}
              onEditProvider={() => { setDialog({ kind: 'edit-provider', provider }); }}
              onAddModels={() => { setDialog({ kind: 'add-models', provider }); }}
              onModelAction={onModelAction(provider)}
            />
          ))}
        </div>
      )}
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
    </>
  );
}
