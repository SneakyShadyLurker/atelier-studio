import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import type { AdminModel, TextModelStatus, TextModelUsage } from '@atelier/shared';
import { TEXT_REASONING_EFFORT_LABELS, TEXT_TASK_LABELS } from '@atelier/shared';
import { I } from '../icons/I';
import OverflowMenu, { type OverflowMenuGroup } from '../OverflowMenu';
import styles from './index.module.css';

export type ModelAction = 'edit' | 'test' | 'remove';

/** "A", "A and B", "A, B, and C". */
export function joinWords(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1) ?? ''}`;
}

/** What depends on a model (or on several, merged), as phrases for the confirmations. */
export function usagePhrases(usage: TextModelUsage, imageLabel: (id: string) => string): string[] {
  const parts: string[] = [];
  if (usage.isDefault) parts.push('the default model');
  if (usage.tasks.length > 0) parts.push(`assigned to ${joinWords(usage.tasks.map((task) => TEXT_TASK_LABELS[task]))}`);
  if (usage.writers.length > 0) parts.push(`the prompt writer for ${joinWords(usage.writers.map(imageLabel))}`);
  if (usage.userPicks > 0) parts.push(`picked by ${usage.userPicks} ${usage.userPicks === 1 ? 'person' : 'people'}`);
  return parts;
}

/** Body of the remove confirmation, from the usage the server reported. */
export function removeModelCopy(usage: TextModelUsage, imageLabel: (id: string) => string): string {
  const parts = usagePhrases(usage, imageLabel);
  if (parts.length === 0) return 'Nothing uses it right now.';
  return `It is ${joinWords(parts)}. Those will fall back to the next model in line.`;
}

/** One fixed slot per capability (label null when absent), so the icons line up down the list. */
function capabilitySlots(model: AdminModel): readonly { key: string; label: string | null; icon: ReactNode }[] {
  const levels = model.reasoningLevels.map((level) => TEXT_REASONING_EFFORT_LABELS[level]).join(', ');
  return [
    { key: 'vision', label: model.vision ? 'Image input' : null, icon: <I.image /> },
    { key: 'json', label: model.structuredOutput === 'none' ? null : 'JSON output', icon: <I.braces /> },
    { key: 'reasoning', label: levels === '' ? null : `Reasoning: ${levels}`, icon: <I.reasoning /> },
  ];
}

/** The routing role a model carries, for the tag beside its name; null when routing does not use it. */
export function usageTag(usage: TextModelUsage, imageLabel: (id: string) => string): { label: string; detail: string } | null {
  if (!usage.isDefault && usage.tasks.length === 0 && usage.writers.length === 0) return null;
  const detail = joinWords(usagePhrases(usage, imageLabel));
  return {
    label: usage.isDefault ? 'Default' : 'In use',
    detail: `${detail.charAt(0).toUpperCase()}${detail.slice(1)}`,
  };
}

const MENU_GROUPS: readonly OverflowMenuGroup<ModelAction>[] = [{
  key: 'model',
  items: [
    { action: 'edit', label: 'Edit', icon: <I.pencil /> },
    { action: 'test', label: 'Test', icon: <I.check /> },
    { action: 'remove', label: 'Remove', icon: <I.trash />, danger: true },
  ],
}];

const STATUS_WORD: Record<TextModelStatus, string> = {
  available: 'available',
  offline: 'offline',
  unknown: 'unknown',
};

interface ModelRowProps {
  readonly model: AdminModel;
  /** The provider was added moments ago; an unknown status reads "checking…". */
  readonly checking: boolean;
  readonly toggling: boolean;
  readonly imageLabel: (id: string) => string;
  readonly onToggle: (enabled: boolean) => void;
  readonly onAction: (action: ModelAction) => void;
}

// Status re-checks belong to the provider (one refresh lists every model), so
// "Check again" lives in ProviderSection's header, not on each row.
export default function ModelRow({ model, checking, toggling, imageLabel, onToggle, onAction }: ModelRowProps) {
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const word = model.status === 'unknown' && checking ? 'checking…' : STATUS_WORD[model.status];
  const tag = usageTag(model.usage, imageLabel);

  return (
    <li className={styles.modelRow} aria-label={model.displayName} data-enabled={model.enabled ? 'true' : 'false'}>
      <div className={styles.modelIdentity}>
        <div className={styles.modelNameLine}>
          <span className={styles.modelName}>{model.displayName}</span>
          {tag && (
            <span className={styles.tag} data-tone={model.usage.isDefault ? 'strong' : undefined} data-tip={tag.detail}>
              {tag.label}
              <span className="srOnly">{`: ${tag.detail}`}</span>
            </span>
          )}
          {model.verifiedAt === null && model.lastTest === null && (
            // Imported rows start from unverified list hints; the quiet way in to the test.
            <button
              className={`${styles.tag} ${styles.tagButton}`}
              type="button"
              aria-label="Untested: test to confirm capabilities"
              data-tip="Test to confirm capabilities"
              onClick={() => { onAction('test'); }}
            >
              Untested
            </button>
          )}
        </div>
        <span className={styles.modelId}>{model.modelId}</span>
      </div>
      <div className={styles.modelMeta}>
        <span className={styles.caps}>
          {capabilitySlots(model).map(({ key, label, icon }) => (label === null
            ? <span key={key} className={styles.cap} aria-hidden="true" />
            : <span key={key} className={styles.cap} role="img" aria-label={label} data-tip={label}>{icon}</span>))}
        </span>
        <span className={styles.status} data-status={model.status}>
          <span className={styles.statusDot} aria-hidden="true" />
          <span>{word}</span>
        </span>
      </div>
      <div className={styles.modelControls}>
        <button
          className={styles.switch}
          type="button"
          role="switch"
          aria-checked={model.enabled}
          aria-label={`Use ${model.displayName}`}
          data-tip={model.enabled ? 'On' : 'Off'}
          disabled={toggling}
          onClick={() => { onToggle(!model.enabled); }}
        >
          <span className={styles.switchThumb} aria-hidden="true" />
        </button>
        <button
          ref={moreRef}
          className={styles.iconButton}
          type="button"
          aria-label={`More actions for ${model.displayName}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-tip="More"
          onClick={() => { setMenuOpen((open) => !open); }}
        >
          <I.more />
        </button>
      </div>
      <OverflowMenu
        label={`${model.displayName} actions`}
        anchorRef={moreRef}
        open={menuOpen}
        groups={MENU_GROUPS}
        onClose={() => { setMenuOpen(false); }}
        onSelect={(action) => {
          setMenuOpen(false);
          onAction(action);
        }}
      />
    </li>
  );
}
