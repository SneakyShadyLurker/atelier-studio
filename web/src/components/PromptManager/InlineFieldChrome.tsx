import { useId } from 'react';
import type { ComponentPropsWithoutRef, Ref } from 'react';
import { I } from '../icons/I';
import styles from './index.module.css';

// Shared name/title field chrome for the three PromptManager editors
// (DimensionEditor, ListEditor, TemplateEditor). Name-save contract: the name
// is editor-local state that persists ONLY via the editor's explicit "Save"
// button — never commit-on-blur. Enter/Escape blur the field (they do not
// submit or commit). The rail double-click rename is a separate, intentional
// gesture and does not go through this component.
//
// No tooltip: the field shows its own value, so a label would only echo what
// is being typed, and its Escape dismissal would take the key from the
// field's blur. The visually hidden <label> is the accessible name.

type InlineFieldChromeProps = Omit<ComponentPropsWithoutRef<'input'>, 'aria-label'> & {
  kicker: string;
  ariaLabel: string;
  ref?: Ref<HTMLInputElement>;
};

function InlineFieldChrome({
  kicker,
  ariaLabel,
  id,
  ref,
  ...inputProps
}: InlineFieldChromeProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className={styles.inlineTitle}>
      <span className={styles.kicker}>{kicker}</span>
      <span className={styles.inlineTitleField}>
        <label className="srOnly" htmlFor={inputId}>{ariaLabel}</label>
        <input
          ref={ref}
          id={inputId}
          className={styles.inlineTitleInput}
          data-cancel-inline="true"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          {...inputProps}
        />
        <span className={styles.inlineTitlePencil} aria-hidden="true"><I.pencil /></span>
      </span>
    </div>
  );
}

export default InlineFieldChrome;
