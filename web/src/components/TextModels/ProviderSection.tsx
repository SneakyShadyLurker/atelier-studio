import { useEffect, useId, useState } from 'react';
import type { AdminModel, AdminProvider, TextProtocol, TextProviderWarning } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { useRefreshProvider, useUpdateModel } from '../../hooks/useTextProviders';
import { I } from '../icons/I';
import btn from '../../styles/buttons.module.css';
import ModelRow, { type ModelAction } from './ModelRow';
import styles from './index.module.css';

/** How long a new provider's unknown models read "checking…" (spec § 12.3). */
const FIRST_POLL_MS = 10_000;

const PROTOCOL_LABEL: Record<TextProtocol, string> = {
  'openai-compatible': 'OpenAI-compatible',
  anthropic: 'Anthropic',
};

const WARNING_COPY: Record<TextProviderWarning, string> = {
  'screen-requests-without-key':
    'A model here screens requests first, but this server has no OPENROUTER_API_KEY, so screening cannot run.',
  'byok-not-configured':
    'This server has no BYOK_ENCRYPTION_KEY, so the stored key cannot be read. Set it and restart Atelier.',
};

function AuthSummary({ provider }: { provider: AdminProvider }) {
  if (provider.auth === 'env') {
    return <span>key from <span className={styles.mono}>{provider.envVar ?? 'the server environment'}</span></span>;
  }
  if (provider.auth === 'stored') {
    return <span>key <span className={styles.mono}>{`••••${(provider.fingerprint ?? '').slice(-4)}`}</span></span>;
  }
  return <span>no key</span>;
}

function useFirstPoll(createdAt: number): boolean {
  const [fresh, setFresh] = useState(() => Date.now() - createdAt < FIRST_POLL_MS);
  useEffect(() => {
    if (!fresh) return undefined;
    const timer = setTimeout(() => { setFresh(false); }, Math.max(0, createdAt + FIRST_POLL_MS - Date.now()));
    return () => { clearTimeout(timer); };
  }, [createdAt, fresh]);
  return fresh;
}

interface ProviderSectionProps {
  readonly provider: AdminProvider;
  readonly imageLabel: (id: string) => string;
  readonly onEditProvider: () => void;
  readonly onAddModels: () => void;
  readonly onModelAction: (model: AdminModel, action: ModelAction) => void;
}

export default function ProviderSection({ provider, imageLabel, onEditProvider, onAddModels, onModelAction }: ProviderSectionProps) {
  const headingId = useId();
  const addToast = useAtelierStore((state) => state.addToast);
  const refresh = useRefreshProvider();
  const updateModel = useUpdateModel();
  const checking = useFirstPoll(provider.createdAt);
  const enabledCount = provider.models.filter((model) => model.enabled).length;
  const needsCheck = !checking && provider.models.some((model) => model.status !== 'available');
  const allOffline = provider.models.length > 0 && provider.models.every((model) => model.status === 'offline');

  const checkAgain = () => {
    refresh.mutateAsync(provider.id).catch((error: unknown) => {
      addToast(describeError(error, `Couldn’t check ${provider.name}.`), 'error');
    });
  };

  return (
    <section className={`${styles.panel} ${styles.providerCard}`} aria-labelledby={headingId} data-enabled={provider.enabled ? 'true' : 'false'}>
      <header className={styles.providerHead}>
        <div className={styles.providerTitle}>
          <div className={styles.providerNameLine}>
            <h3 id={headingId} className={styles.providerName}>{provider.name}</h3>
            {!provider.enabled && <span className={styles.tag}>Off</span>}
          </div>
          <p className={styles.providerMeta}>
            <span>{PROTOCOL_LABEL[provider.protocol]}</span>
            <span className={styles.mono}>{provider.baseUrl}</span>
            <AuthSummary provider={provider} />
          </p>
        </div>
        <div className={styles.providerActions}>
          {provider.models.length > 0 && (
            <span className={styles.count}>{`${enabledCount} of ${provider.models.length} on`}</span>
          )}
          {needsCheck && (
            <button className={`${btn.secondary} ${styles.compactButton} ${styles.ghostButton}`} type="button" disabled={refresh.isPending} onClick={checkAgain}>
              Check again
            </button>
          )}
          <button className={`${btn.secondary} ${styles.compactButton}`} type="button" onClick={onAddModels}>
            <I.plus aria-hidden="true" />
            Add models
          </button>
          <button
            className={styles.iconButton}
            type="button"
            aria-label={`Edit ${provider.name}`}
            data-tip="Edit provider"
            onClick={onEditProvider}
          >
            <I.pencil />
          </button>
        </div>
      </header>

      {(!provider.enabled || provider.warnings.length > 0 || allOffline) && (
        <div className={styles.providerNotes}>
          {!provider.enabled && <p className={styles.note}>This provider is turned off. Its models are not used.</p>}
          {provider.warnings.map((warning) => (
            <p key={warning} className={styles.warning}>
              <I.warn aria-hidden="true" />
              <span>{WARNING_COPY[warning]}</span>
            </p>
          ))}
          {allOffline && (
            <p className={styles.note}>
              {`Nothing listed at ${provider.baseUrl}. Check that the server is running.`}
            </p>
          )}
        </div>
      )}

      {provider.models.length === 0 ? (
        <p className={`${styles.note} ${styles.providerEmpty}`}>No models yet.</p>
      ) : (
        <ul className={styles.modelList}>
          {provider.models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              checking={checking}
              imageLabel={imageLabel}
              toggling={updateModel.isPending && updateModel.variables.modelId === model.id}
              onToggle={(enabled) => {
                updateModel.mutateAsync({ providerId: provider.id, modelId: model.id, patch: { enabled } })
                  .catch((error: unknown) => {
                    addToast(describeError(error, `Couldn’t turn ${model.displayName} ${enabled ? 'on' : 'off'}.`), 'error');
                  });
              }}
              onAction={(action) => { onModelAction(model, action); }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
