import type { Model, PublicTextModel, TaskRow, TextModelsResponse, TextTask } from '@atelier/shared';
import { TEXT_TASK_DESCRIPTIONS, TEXT_TASK_GROUPS, TEXT_TASK_LABELS } from '@atelier/shared';
import { useDeferredValue, useMemo, ViewTransition } from 'react';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { useModels } from '../../hooks/useModels';
import { usePromptLibrary } from '../../hooks/usePromptLibrary';
import { usePendingTaskPicks, useSetTaskPick, useTextModels } from '../../hooks/useTextModels';
import {
  DEFAULT_PICK,
  EFFORT_FIXED_LABEL,
  defaultModelId,
  effortChipLabel,
  effortOptions,
  modelOptions,
  personalUnsetChip,
  rowPick,
  sharedSetupLabel,
  type EffortValue,
} from '../../lib/textModelPick';
import ChipSelect from '../Composer/ChipSelect';
import { ErrorState, LoadingState, StateView } from '../StateView';
import { ChipText, FeatureGroup, FeaturePanel, FeatureRow } from './FeatureRow';
import styles from './index.module.css';

interface NoTextModelStateProps {
  /** A text admin is pointed to Providers; everyone else to their admin. */
  readonly admin: boolean;
  readonly onGoToProviders?: (() => void) | undefined;
}

/** No text model is connected (`GET /api/text-models` lists none). */
export function NoTextModelState({ admin, onGoToProviders }: NoTextModelStateProps) {
  if (admin && onGoToProviders !== undefined) {
    return (
      <StateView
        art="empty-text-models"
        title="No text model yet"
        body="Add a provider and its models under Providers."
        action={{ label: 'Go to Providers', onClick: onGoToProviders }}
      />
    );
  }
  return (
    <StateView
      art="empty-text-models"
      title="No text model yet"
      body={admin ? 'Add a provider and its models under Providers.' : 'Ask your admin to connect a text model.'}
    />
  );
}

interface YourPicksProps {
  readonly admin: boolean;
  readonly onGoToProviders?: (() => void) | undefined;
}

interface WritersNoteProps {
  readonly data: TextModelsResponse;
  readonly imageModels: readonly Model[] | undefined;
}

/**
 * One sentence per image model with a prompt writer, so precedence is stated
 * where it bites. An image model this client does not know is skipped.
 */
function WritersNote({ data, imageModels }: WritersNoteProps) {
  const imageName = new Map((imageModels ?? []).map((model) => [model.id, model.name]));
  const textName = new Map(data.models.map((model) => [model.id, model.displayName]));
  const locked = new Set(data.lockedWriters);
  const lines = Object.entries(data.writers).flatMap(([imageModelId, writerId]) => {
    const image = imageName.get(imageModelId);
    const writer = textName.get(writerId);
    return image === undefined || writer === undefined ? [] : [{ imageModelId, image, writer, locked: locked.has(imageModelId) }];
  });
  if (lines.length === 0) return null;
  return (
    <div className={styles.writersNote} role="note">
      {lines.map(({ imageModelId, image, writer, locked: isLocked }) => (
        <p key={imageModelId}>
          <span className={styles.noteName}>{image}</span>
          {isLocked ? ' is always written by ' : ' is written by '}
          <span className={styles.noteName}>{writer}</span>
          {isLocked ? ', whichever model you pick.' : ' unless you pick a model for the feature.'}
        </p>
      ))}
    </div>
  );
}

interface YourPicksProps {
  readonly admin: boolean;
  readonly onGoToProviders?: (() => void) | undefined;
}

/** The signed-in person's own model and effort per feature. */
export default function YourPicks({ admin, onGoToProviders }: YourPicksProps) {
  const settings = useTextModels();
  const setPick = useSetTaskPick();
  const saving = usePendingTaskPicks();
  const promptLibrary = usePromptLibrary();
  const imageModels = useModels().data;
  const addToast = useAtelierStore((state) => state.addToast);

  // One render snapshot of the query: the loading, error, empty and loaded
  // states swap in a Transition, each through its own part boundary.
  // Access stays known through a failed background refetch (cached data, no
  // 404): `enabled` alone would drop the Prompt Library rows until it recovers.
  const libraryEnabled = promptLibrary.data !== undefined && !promptLibrary.gated;
  const liveSnapshot = useMemo(
    () => ({ pending: settings.isPending, data: settings.data, admin, libraryEnabled, imageModels }),
    [settings.isPending, settings.data, admin, libraryEnabled, imageModels],
  );
  const snapshot = useDeferredValue(liveSnapshot);

  if (snapshot.pending) {
    return (
      <ViewTransition key="loading" default="none" enter="part-enter" exit="part-exit">
        <LoadingState label="Loading settings…" />
      </ViewTransition>
    );
  }
  // A failed background refetch keeps the last data; only a panel with none
  // falls back to the error state.
  if (snapshot.data === undefined) {
    return (
      <ViewTransition key="error" default="none" enter="part-enter" exit="part-exit">
        <ErrorState
          message="Couldn’t load the text model settings."
          onRetry={() => { void settings.refetch(); }}
        />
      </ViewTransition>
    );
  }

  const data = snapshot.data;
  if (data.models.length === 0) {
    return (
      <ViewTransition key="empty" default="none" enter="part-enter" exit="part-exit">
        <NoTextModelState admin={snapshot.admin} onGoToProviders={onGoToProviders} />
      </ViewTransition>
    );
  }

  const byId = new Map(data.models.map((model) => [model.id, model]));
  // Rows come from the shared task groups, so every task shows even when the
  // response omits one, and a task this bundle does not know is skipped.
  const rowByTask = new Map(data.tasks.map((row) => [row.task, row]));
  // Prompt Library features show only once access is known to be granted.
  const groups = TEXT_TASK_GROUPS.filter((group) => !group.needsPromptLibrary || snapshot.libraryEnabled);

  // The snapshot is for rendering only: a handler reads the live listing.
  const liveRow = (task: TextTask) => {
    const live = settings.data;
    if (live === undefined) return undefined;
    const liveById = new Map<string, PublicTextModel>(live.models.map((model) => [model.id, model]));
    const row = live.tasks.find((candidate) => candidate.task === task) ?? { task };
    return { byId: liveById, ...rowPick(row, liveById) };
  };
  const saveModel = (task: TextTask, next: string) => {
    const live = liveRow(task);
    // ChipSelect still reports dimmed rows; an offline model is not selectable.
    if (live === undefined || (next !== DEFAULT_PICK && live.byId.get(next)?.status === 'offline')) return;
    // mutateAsync: a second row's mutate() replaces per-call callbacks,
    // which silenced the first save's failure toast.
    setPick.mutateAsync({ task, modelId: next === DEFAULT_PICK ? null : next })
      .catch((error: unknown) => {
        addToast(describeError(error, "Couldn't save the text model."), 'error');
      });
  };
  const saveEffort = (task: TextTask, next: EffortValue) => {
    const activePick = liveRow(task)?.activePick;
    if (activePick === undefined) return;
    setPick.mutateAsync({ task, modelId: activePick.id, effort: next === 'default' ? null : next })
      .catch((error: unknown) => {
        addToast(describeError(error, "Couldn't save the reasoning effort."), 'error');
      });
  };

  const renderRow = (task: TextTask) => {
    const row: TaskRow = rowByTask.get(task) ?? { task };
    const label = TEXT_TASK_LABELS[task];
    const inheritedId = defaultModelId(data, row, byId);
    const inheritedName = inheritedId === undefined ? undefined : byId.get(inheritedId)?.displayName;
    // An effort belongs to a pick the task actually uses; the shared setup keeps its own.
    const { picked, offlinePick, activePick, effort } = rowPick(row, byId);
    const display = picked !== undefined ? picked.displayName : sharedSetupLabel(inheritedName);
    const effortDisplay = effortChipLabel(effort);
    const rowSaving = saving.has(task);
    const title = picked?.displayName ?? inheritedName;
    const effortSlot = activePick?.reasoningLevels.length === 0 ? (
      <p className={styles.effortFixed}>{EFFORT_FIXED_LABEL}</p>
    ) : (
      <span
        className={styles.effortHolder}
        style={{ visibility: activePick === undefined ? 'hidden' : undefined }}
        inert={activePick === undefined}
        aria-hidden={activePick === undefined ? true : undefined}
      >
        <ChipSelect<EffortValue>
          ariaLabel={`Reasoning effort for ${label}, currently ${effortDisplay}`}
          valueDisplay={effortDisplay}
          options={activePick === undefined ? effortOptions([]) : effortOptions(activePick.reasoningLevels)}
          value={effort}
          disabled={activePick === undefined || rowSaving}
          onChange={(next) => { saveEffort(task, next); }}
        />
      </span>
    );
    return (
      <FeatureRow
        key={task}
        label={label}
        description={TEXT_TASK_DESCRIPTIONS[task]}
        note={offlinePick && picked !== undefined ? (
          <p className={styles.featureNote}>
            {`${picked.displayName} is offline right now; ${label} is using the shared setup.`}
          </p>
        ) : undefined}
        model={(
          <ChipSelect<string>
            ariaLabel={`Text model for ${label}, currently ${display}`}
            valueDisplay={activePick === undefined
              ? <ChipText value={picked === undefined ? personalUnsetChip(inheritedName) : { text: picked.displayName, quiet: true, inherited: false }} />
              : activePick.displayName}
            {...(title === undefined ? {} : { valueTitle: title })}
            options={modelOptions(data.models, inheritedName)}
            value={picked?.id ?? DEFAULT_PICK}
            disabled={rowSaving}
            onChange={(next) => { saveModel(task, next); }}
          />
        )}
        effort={effortSlot}
      />
    );
  };

  return (
    <ViewTransition key="loaded" default="none" enter="part-enter" exit="part-exit">
      <div className={styles.picks}>
        <WritersNote data={data} imageModels={snapshot.imageModels} />
        <FeaturePanel
          label="Your picks"
          note="Pick a model for a feature to use it instead of the shared one. A feature you leave alone follows the shared setup, shown with ↳."
        >
          {groups.map((group) => (
            <FeatureGroup key={group.id} label={group.label}>
              {group.tasks.map(renderRow)}
            </FeatureGroup>
          ))}
        </FeaturePanel>
      </div>
    </ViewTransition>
  );
}
