import { LIST_DESCRIPTION_MAX_CHARS } from '@atelier/shared/prompt-limits';
import { DescribeDialog } from '../DescribeDialog';

interface DescribeListDialogProps {
  question?: string;
  busy: boolean;
  error: string | null;
  onSubmit: (description: string) => void;
  onCancel: () => void;
}

const SEED_BODY = 'Describe what this list should contain. The AI will generate up to 10 starter entries you can edit, reorder, or delete.';

export default function DescribeListDialog({ question, busy, error, onSubmit, onCancel }: DescribeListDialogProps) {
  return (
    <DescribeDialog
      sectionLabel="DESCRIBE THE LIST"
      title="Tell the AI what this list is"
      body={question ?? SEED_BODY}
      fieldLabel="List description"
      placeholder="e.g. a list of cat breeds for a portrait template"
      maxLength={LIST_DESCRIPTION_MAX_CHARS}
      submitLabel="Generate list"
      busy={busy}
      error={error}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
