import type { RefImageDraft } from '../../store/atelier';
import { I } from '../icons/I';
import styles from './index.module.css';

interface RefImageRowProps {
  files: readonly RefImageDraft[];
  maxRefImages: number;
  onAdd: (files: File[]) => void;
  onRemove: (clientId: string) => void;
  onCapReached: () => void;
  disabled: boolean;
}

export const ACCEPTED_REF_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/tiff,image/avif,.heic,.heif,.avif,.tif,.tiff';

export function RefImageRow({
  files,
  maxRefImages,
  onAdd,
  onRemove,
  onCapReached,
  disabled,
}: RefImageRowProps) {
  const atCap = files.length >= maxRefImages;
  return (
    <div className={styles.refRow} aria-label="Reference images">
      <button
        className={styles.attach}
        type="button"
        aria-label="Attach reference images"
        data-tip="Attach refs"
        disabled={disabled || atCap}
        onClick={(event) => {
          if (atCap) {
            event.preventDefault();
            onCapReached();
            return;
          }
          const input = event.currentTarget.nextElementSibling;
          if (input instanceof HTMLInputElement) input.click();
        }}
      >
        <I.paperclip />
      </button>
      <input
        className={styles.fileInput}
        type="file"
        accept={ACCEPTED_REF_ACCEPT}
        multiple
        onChange={(event) => {
          onAdd(Array.from(event.target.files ?? []));
          event.currentTarget.value = '';
        }}
      />
      {files.map((ref, index) => {
        const hasError = ref.status === 'error' && Boolean(ref.error);
        const errorId = `ref-error-${ref.clientId}`;
        return (
          <div
            key={ref.clientId}
            className={`${styles.refChip} ${ref.status === 'uploading' ? styles.refChipUploading : ''} ${ref.status === 'error' ? styles.refChipError : ''}`}
            data-tip={ref.error}
          >
            <img
              src={ref.previewUrl}
              alt={`Reference image ${index + 1}`}
              aria-describedby={hasError ? errorId : undefined}
            />
            {hasError ? <span className="srOnly" id={errorId}>{ref.error}</span> : null}
            <button
              className={styles.refRemove}
              type="button"
              aria-label={`Remove reference image ${index + 1}`}
              disabled={ref.status === 'uploading'}
              onClick={() => { onRemove(ref.clientId); }}
            >
              <I.close />
            </button>
          </div>
        );
      })}
    </div>
  );
}
