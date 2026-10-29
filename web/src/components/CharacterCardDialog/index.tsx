import { CHARACTER_CARD_DIRECTION_MAX_CHARS } from '@atelier/shared';
import type { CharacterCardKind } from '@atelier/shared';
import { useId, useState } from 'react';
import { DescribeDialog } from '../DescribeDialog';
import styles from './index.module.css';

interface CharacterCardDialogProps {
  /** The steering and kind of the tile's unfinished attempt, so a plain retry keeps them. */
  initial: { readonly direction: string; readonly kind: CharacterCardKind };
  /** Receives the direction ('' when left blank) and the chosen kind; the caller closes the dialog. */
  onSubmit: (direction: string, kind: CharacterCardKind) => void;
  onCancel: () => void;
}

const KINDS: readonly { kind: CharacterCardKind; title: string; hint: string; placeholder: string }[] = [
  {
    kind: 'subject',
    title: 'Single subject',
    hint: 'One person',
    placeholder: 'e.g. a retired sea captain, gruff but kind, who speaks with a Scottish lilt',
  },
  {
    kind: 'group',
    title: 'Multiple subjects',
    hint: 'Two or three people',
    placeholder: 'e.g. two sisters who run a failing vineyard together and never agree on anything',
  },
  {
    kind: 'scenario',
    title: 'Scenario',
    hint: 'A world and its cast',
    placeholder: 'e.g. a rain-soaked port city where you arrive as the new harbour inspector',
  },
];

// The body copy stays constant across kinds: DescribeDialog clears its field
// whenever `body` changes, so only the placeholder follows the picked kind.
const BODY =
  'Choose what Ephemera should write, then steer it if you like: names, personalities, history, relationships or the world. Leave the direction blank to write the card from the image and its prompt alone.';

// Card kind and optional steering before an Ephemera character card is
// written. Submitting closes at once: the card is written in the background
// and the tile's spinner and the result toast report it.
export default function CharacterCardDialog({ initial, onSubmit, onCancel }: CharacterCardDialogProps) {
  const [kind, setKind] = useState<CharacterCardKind>(initial.kind);
  const name = useId();
  const placeholder = KINDS.find((option) => option.kind === kind)?.placeholder ?? '';
  return (
    <DescribeDialog
      sectionLabel="CHARACTER CARD"
      title="Create a character card"
      body={BODY}
      fieldLabel="Direction for the character card"
      placeholder={placeholder}
      maxLength={CHARACTER_CARD_DIRECTION_MAX_CHARS}
      submitLabel="Create card"
      busy={false}
      optional
      initialText={initial.direction}
      onSubmit={(direction) => { onSubmit(direction, kind); }}
      onCancel={onCancel}
    >
      <fieldset className={styles.kinds}>
        <legend className="srOnly">Card type</legend>
        {KINDS.map((option) => (
          <label key={option.kind} className={styles.kind}>
            <input
              type="radio"
              className="srOnly"
              name={name}
              value={option.kind}
              checked={kind === option.kind}
              onChange={() => { setKind(option.kind); }}
            />
            <span className={styles.kindTitle}>{option.title}</span>
            <span className={styles.kindHint}>{option.hint}</span>
          </label>
        ))}
      </fieldset>
    </DescribeDialog>
  );
}
