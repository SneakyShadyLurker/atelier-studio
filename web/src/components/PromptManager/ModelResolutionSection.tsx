import type { ModelResolutionPutRequest, ModelResolutionSetting, RenderResolution } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import {
  useModelResolution,
  usePendingModelResolution,
  useSetModelResolution,
} from '../../hooks/useModelResolution';
import ChipSelect, { type ChipSelectOption } from '../Composer/ChipSelect';
import { ErrorState } from '../StateView';
import buttons from '../../styles/buttons.module.css';
import styles from './SettingsPanel.module.css';

const RESOLUTION_LABELS: Readonly<Record<RenderResolution, string>> = {
  '4mp': '4 MP',
  '8mp': '8 MP',
  '16mp': '16 MP',
};

/** "2K" for a 2048 px long edge, else the pixel count. */
function longEdgeLabel(pixels: number): string {
  return pixels === 2048 ? '2K' : `${pixels} px`;
}

function optionLabel(value: RenderResolution, fallback: RenderResolution): string {
  return value === fallback ? `${RESOLUTION_LABELS[value]} (default)` : RESOLUTION_LABELS[value];
}

interface ModeControlProps {
  readonly label: string;
  readonly modelName: string;
  readonly options: readonly RenderResolution[];
  readonly fallback: RenderResolution;
  readonly override: RenderResolution | null;
  readonly saving: boolean;
  readonly onChange: (value: RenderResolution | null) => void;
}

function ModeControl({ label, modelName, options, fallback, override, saving, onChange }: ModeControlProps) {
  const value = override ?? fallback;
  const display = optionLabel(value, fallback);
  const chipOptions: readonly ChipSelectOption<RenderResolution>[] = options.map((option) => ({
    value: option,
    label: optionLabel(option, fallback),
  }));
  return (
    <span className={styles.modeControl}>
      <span className={styles.modeLabel} aria-hidden>{label}</span>
      <ChipSelect<RenderResolution>
        ariaLabel={`${label} resolution for ${modelName}, currently ${display}`}
        valueDisplay={override === null ? <span className={styles.unsetValue}>{display}</span> : display}
        options={chipOptions}
        value={value}
        disabled={saving}
        onChange={(next) => {
          if (next === value) return;
          // The default is stored as no override.
          onChange(next === fallback ? null : next);
        }}
      />
    </span>
  );
}

interface DownscaleControlProps {
  readonly modelName: string;
  readonly outputLongEdge: number;
  readonly checked: boolean;
  readonly saving: boolean;
  readonly onChange: (downscale: boolean) => void;
}

/** "Downsize to 2K": on reduces the render to the row's long edge, off delivers it as rendered. */
function DownscaleControl({ modelName, outputLongEdge, checked, saving, onChange }: DownscaleControlProps) {
  const size = longEdgeLabel(outputLongEdge);
  return (
    <label className={styles.modeControl}>
      <span className={styles.modeLabel} aria-hidden>Downsize to {size}</span>
      <button
        type="button"
        role="switch"
        className={styles.switch}
        aria-checked={checked}
        aria-label={`Downsize ${modelName} to ${size}`}
        disabled={saving}
        onClick={() => { onChange(!checked); }}
      >
        <span className={styles.switchThumb} aria-hidden="true" />
      </button>
    </label>
  );
}

interface ResolutionRowProps {
  readonly model: ModelResolutionSetting;
  readonly options: readonly RenderResolution[];
  readonly saving: boolean;
  readonly onSave: (update: ModelResolutionPutRequest) => void;
}

function ResolutionRow({ model, options, saving, onSave }: ResolutionRowProps) {
  const { defaultReference, outputLongEdge } = model;
  const downsizeOff = outputLongEdge !== null && !model.downscale;
  const tuned = model.textToImage !== null || model.reference !== null || downsizeOff;
  return (
    <div className={`${styles.row} ${styles.sizeRow}`}>
      <div className={styles.rowMain}>
        <p className={styles.rowLabel}>{model.name}</p>
      </div>
      <div className={styles.rowControl}>
        <ModeControl
          label="Text to image"
          modelName={model.name}
          options={options}
          fallback={model.defaultTextToImage}
          override={model.textToImage}
          saving={saving}
          onChange={(textToImage) => { onSave({ textToImage }); }}
        />
        {defaultReference !== null && (
          <ModeControl
            label="With reference pictures"
            modelName={model.name}
            options={options}
            fallback={defaultReference}
            override={model.reference}
            saving={saving}
            onChange={(reference) => { onSave({ reference }); }}
          />
        )}
        {outputLongEdge !== null && (
          <DownscaleControl
            modelName={model.name}
            outputLongEdge={outputLongEdge}
            checked={model.downscale}
            saving={saving}
            onChange={(downscale) => { onSave({ downscale }); }}
          />
        )}
        <button
          type="button"
          className={buttons.secondary}
          aria-label={`Reset ${model.name} to its default resolutions`}
          disabled={!tuned || saving}
          onClick={() => {
            // Only the settings the row offers are reset.
            onSave({
              textToImage: null,
              ...(defaultReference !== null ? { reference: null } : {}),
              ...(outputLongEdge !== null ? { downscale: true } : {}),
            });
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function isNonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export default function ModelResolutionSection() {
  const settings = useModelResolution();
  const setResolution = useSetModelResolution();
  const saving = usePendingModelResolution();
  const addToast = useAtelierStore((state) => state.addToast);

  // Nothing to show until the list arrives; users without such models get none.
  if (settings.isPending) return null;
  if (settings.data === undefined) {
    return (
      <section className={styles.panel} aria-label="Render resolution settings">
        <ErrorState
          message="Couldn’t load the render resolution settings."
          onRetry={() => { void settings.refetch(); }}
        />
      </section>
    );
  }
  const { models, options } = settings.data;
  // The response is not validated; a malformed one hides the section.
  if (!isNonEmptyList(models) || !isNonEmptyList(options)) return null;

  return (
    <section className={styles.panel} aria-label="Render resolution settings">
      <div className={styles.head} data-zone="head">
        <h2 className={styles.headTitle}>Render resolution</h2>
      </div>
      <div className={styles.body} data-zone="body">
        {models.map((model) => (
          <ResolutionRow
            key={model.modelId}
            model={model}
            options={options}
            saving={saving.has(model.modelId)}
            // mutateAsync, not mutate's per-call onError: a second row's save
            // replaces mutate's callbacks, which silenced the first one's failure.
            onSave={(update) => {
              setResolution.mutateAsync({ modelId: model.modelId, update }).catch((error: unknown) => {
                addToast(describeError(error, "Couldn't save the render resolution."), 'error');
              });
            }}
          />
        ))}
      </div>
    </section>
  );
}
