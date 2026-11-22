import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { usePendingPromptCondense, usePromptCondense, useSetPromptCondense } from '../../hooks/usePromptCondense';
import { ErrorState } from '../StateView';
import styles from './SettingsPanel.module.css';

/** The "Condense long prompts" switch for Krea rows. */
export default function PromptCondenseSection() {
  const settings = usePromptCondense();
  const setCondense = useSetPromptCondense();
  const saving = usePendingPromptCondense();
  const addToast = useAtelierStore((state) => state.addToast);

  // Nothing to show until the setting arrives; users without Krea rows get none.
  if (settings.isPending) return null;
  if (settings.data === undefined) {
    return (
      <section className={styles.panel} aria-label="Prompt condensing settings">
        <ErrorState
          message="Couldn’t load the prompt condensing setting."
          onRetry={() => { void settings.refetch(); }}
        />
      </section>
    );
  }
  const { available, enabled } = settings.data;
  if (!available) return null;

  return (
    <section className={styles.panel} aria-label="Prompt condensing settings">
      <div className={styles.head} data-zone="head">
        <h2 className={styles.headTitle}>Prompt condensing</h2>
      </div>
      <div className={styles.body} data-zone="body">
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <p className={styles.rowLabel}>Condense long prompts</p>
            <p className={styles.rowDescription}>
              Shortens a Krea prompt that runs over its word budget before it renders. Off sends the
              prompt as written.
            </p>
          </div>
          <div className={styles.rowControl}>
            <button
              type="button"
              role="switch"
              className={styles.switch}
              aria-checked={enabled}
              aria-label="Condense long prompts"
              disabled={saving}
              onClick={() => {
                // mutateAsync: mutate's per-call callbacks are replaced by a later call.
                setCondense.mutateAsync(!enabled).catch((error: unknown) => {
                  addToast(describeError(error, "Couldn't save the prompt condensing setting."), 'error');
                });
              }}
            >
              <span className={styles.switchThumb} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
