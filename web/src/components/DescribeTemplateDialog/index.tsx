import { TEMPLATE_DESCRIPTION_MAX_CHARS } from '@atelier/shared/prompt-limits';
import type { TaskModelChoice } from '../../hooks/useTaskModelChoice';
import { DescribeDialog } from '../DescribeDialog';
import { ModelFields } from './ModelFields';

interface DescribeTemplateDialogProps {
  mode: 'seed' | 'rework' | 'clarify';
  question: string | null;
  busy: boolean;
  error?: string | null;
  /** The text model and reasoning level that write the draft (seed and rework). */
  modelChoice?: TaskModelChoice;
  onSubmit: (description: string) => void;
  onCancel: () => void;
}

const SEED_TITLE = 'Describe the template';
const SEED_BODY = 'Tell the AI what kind of image-gen template to draft — subject, mood, lens, style. The AI will use your variable library for entropy.';

const REWORK_TITLE = 'Rework the template';
const REWORK_BODY = "Say what should change. The AI rewrites the body and keeps everything you don't mention, your tokens included.";

const CLARIFY_TITLE = 'One more thing';

export default function DescribeTemplateDialog({ mode, question, busy, error = null, modelChoice, onSubmit, onCancel }: DescribeTemplateDialogProps) {
  const fields = modelChoice !== undefined && mode !== 'clarify'
    ? <ModelFields choice={modelChoice} disabled={busy} />
    : null;
  if (mode === 'rework') {
    return (
      <DescribeDialog
        title={REWORK_TITLE}
        body={REWORK_BODY}
        fieldLabel="Change instructions"
        placeholder="e.g. make the lighting moodier and move the outfit into a variable"
        maxLength={TEMPLATE_DESCRIPTION_MAX_CHARS}
        submitLabel="Rework template"
        busyLabel="Reworking…"
        busy={busy}
        error={error}
        onSubmit={onSubmit}
        onCancel={onCancel}
      >
        {fields}
      </DescribeDialog>
    );
  }
  const isSeed = mode === 'seed';
  return (
    <DescribeDialog
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
    >
      {fields}
    </DescribeDialog>
  );
}
