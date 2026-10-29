import { TEMPLATE_DESCRIPTION_MAX_CHARS } from '@atelier/shared/prompt-limits';
import { DescribeDialog } from '../DescribeDialog';

interface DescribeTemplateDialogProps {
  mode: 'seed' | 'clarify';
  question: string | null;
  busy: boolean;
  error?: string | null;
  onSubmit: (description: string) => void;
  onCancel: () => void;
}

const SEED_LABEL = 'DESCRIBE THE TEMPLATE';
const SEED_TITLE = 'Describe the template';
const SEED_BODY = 'Tell the AI what kind of image-gen template to draft — subject, mood, lens, style. The AI will use your variable library for entropy.';

const CLARIFY_LABEL = 'ONE MORE THING';
const CLARIFY_TITLE = 'One more thing';

export default function DescribeTemplateDialog({ mode, question, busy, error = null, onSubmit, onCancel }: DescribeTemplateDialogProps) {
  const isSeed = mode === 'seed';
  return (
    <DescribeDialog
      sectionLabel={isSeed ? SEED_LABEL : CLARIFY_LABEL}
      title={isSeed ? SEED_TITLE : CLARIFY_TITLE}
      body={isSeed ? SEED_BODY : (question ?? '')}
      fieldLabel="Template description"
      placeholder="e.g. moody noir street portrait, overcast light, 35mm"
      maxLength={TEMPLATE_DESCRIPTION_MAX_CHARS}
      submitLabel="Generate template"
      busy={busy}
      error={error}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
