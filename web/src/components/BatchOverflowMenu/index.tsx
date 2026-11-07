import type { Batch } from '@atelier/shared';
import type { ReactNode, RefObject } from 'react';
import { I } from '../icons/I';
import { sequenceActionAvailability } from '../../lib/videoSequences';
import OverflowMenu from '../OverflowMenu';
import { useIsPhone } from '../../hooks/useIsPhone';

export type BatchOverflowAction =
  | 'reroll' | 'reopen' | 'copy' | 'saveTemplate' | 'pin' | 'move'
  | 'playMaster' | 'downloadMaster' | 'extendSequence' | 'discardSequenceTail' | 'cancelStory';

interface BatchOverflowMenuProps {
  batch: Batch;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  promptsEnabled: boolean;
  readOnlyActions: boolean;
  i2vAvailable?: boolean;
  onSelect: (action: BatchOverflowAction) => void;
  onClose: () => void;
}

type GroupKey = 'generate' | 'sequence' | 'prompt' | 'organize';

interface MenuItem {
  action: BatchOverflowAction;
  label: string;
  icon: ReactNode;
  group: GroupKey;
  show: boolean;
  disabled: boolean;
  chevron?: boolean;
  danger?: boolean;
}

const GROUP_ORDER: readonly { key: GroupKey; label: string }[] = [
  { key: 'generate', label: 'Generate' },
  { key: 'sequence', label: 'Sequence' },
  { key: 'prompt', label: 'Prompt' },
  { key: 'organize', label: 'Organize' },
];

export function buildBatchOverflowGroups({
  batch, promptsEnabled, readOnlyActions, i2vAvailable = false, isPhone,
}: Pick<BatchOverflowMenuProps, 'batch' | 'promptsEnabled' | 'readOnlyActions' | 'i2vAvailable'> & { isPhone: boolean }) {
  const hasTemplate = batch.provenance != null && batch.provenance.templateId !== null;
  const sequenceActions = sequenceActionAvailability(batch, i2vAvailable);

  const items: readonly MenuItem[] = [
    // The picker only exists behind the prompt-library gate, like Save below.
    { action: 'reopen', label: 'Reopen in picker', icon: <I.sparkle />, group: 'generate', show: hasTemplate && promptsEnabled, disabled: readOnlyActions },
    { action: 'playMaster', label: 'Play master', icon: <I.play />, group: 'sequence', show: sequenceActions.playMaster, disabled: false },
    { action: 'downloadMaster', label: 'Download master', icon: <I.download />, group: 'sequence', show: sequenceActions.downloadMaster, disabled: false },
    { action: 'extendSequence', label: 'Extend', icon: <I.extend />, group: 'sequence', show: sequenceActions.extend, disabled: readOnlyActions },
    { action: 'discardSequenceTail', label: 'Discard tail', icon: <I.trash />, group: 'sequence', show: sequenceActions.discardTail, disabled: readOnlyActions, danger: true },
    { action: 'cancelStory', label: 'Cancel story', icon: <I.close />, group: 'sequence', show: batch.story?.status === 'rendering', disabled: readOnlyActions, danger: true },
    { action: 'copy', label: 'Copy prompt', icon: <I.copy />, group: 'prompt', show: isPhone, disabled: false },
    { action: 'saveTemplate', label: 'Save to templates', icon: <I.library />, group: 'prompt', show: promptsEnabled, disabled: readOnlyActions },
    { action: 'pin', label: 'Pin batch', icon: <I.star />, group: 'organize', show: !batch.pinned, disabled: readOnlyActions },
  ];

  return GROUP_ORDER
    .map((group) => ({ ...group, items: items.filter((item) => item.group === group.key && item.show) }))
    .filter((group) => group.items.length > 0);

}

export default function BatchOverflowMenu({
  batch, anchorRef, open, promptsEnabled, readOnlyActions, i2vAvailable = false, onSelect, onClose,
}: BatchOverflowMenuProps) {
  const isPhone = useIsPhone();
  const groups = buildBatchOverflowGroups({ batch, promptsEnabled, readOnlyActions, i2vAvailable, isPhone });
  return <OverflowMenu label="Batch actions" anchorRef={anchorRef} open={open && groups.length > 0} groups={groups} onSelect={onSelect} onClose={onClose} />;
}
