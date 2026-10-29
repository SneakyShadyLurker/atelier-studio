export const BRAINSTORM_PROMPT_SECTION_KEYS = [
  'prompt',
  'scene',
  'subject',
  'details',
  'constraints',
] as const;

export type BrainstormPromptSectionKey = (typeof BRAINSTORM_PROMPT_SECTION_KEYS)[number];

export const BRAINSTORM_PROMPT_SECTION_LABELS: Readonly<
  Record<Exclude<BrainstormPromptSectionKey, 'prompt'>, string>
> = {
  scene: 'Scene / Image type',
  subject: 'Subject',
  details: 'Details',
  constraints: 'Constraints',
};

export interface BrainstormPromptSection {
  readonly key: BrainstormPromptSectionKey;
  readonly text: string;
}

const LABEL_TO_KEY = new Map<string, Exclude<BrainstormPromptSectionKey, 'prompt'>>(
  Object.entries(BRAINSTORM_PROMPT_SECTION_LABELS).map(([key, label]) => [
    label,
    key as Exclude<BrainstormPromptSectionKey, 'prompt'>,
  ]),
);

const LABEL_PATTERN = new RegExp(
  `^(${[...LABEL_TO_KEY.keys()].map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}): ?(.*)$`,
);

export function splitBrainstormPrompt(text: string): BrainstormPromptSection[] {
  const content = new Map<BrainstormPromptSectionKey, string[]>();
  let current: BrainstormPromptSectionKey = 'prompt';

  for (const line of text.split(/\r?\n/)) {
    const match = LABEL_PATTERN.exec(line);
    if (match) {
      const key = LABEL_TO_KEY.get(match[1] ?? '');
      if (key) {
        current = key;
        const lines = content.get(current) ?? [];
        lines.push(match[2] ?? '');
        content.set(current, lines);
        continue;
      }
    }
    const lines = content.get(current) ?? [];
    lines.push(line);
    content.set(current, lines);
  }

  return BRAINSTORM_PROMPT_SECTION_KEYS.flatMap((key) => {
    const sectionText = content.get(key)?.join('\n').trim() ?? '';
    return sectionText ? [{ key, text: sectionText }] : [];
  });
}

export function joinBrainstormPrompt(sections: readonly BrainstormPromptSection[]): string {
  const byKey = new Map<BrainstormPromptSectionKey, string[]>();
  for (const section of sections) {
    const sectionText = section.text.trim();
    if (!sectionText) continue;
    const values = byKey.get(section.key) ?? [];
    values.push(sectionText);
    byKey.set(section.key, values);
  }

  return BRAINSTORM_PROMPT_SECTION_KEYS.flatMap((key) => {
    const sectionText = byKey.get(key)?.join('\n').trim() ?? '';
    if (!sectionText) return [];
    return [key === 'prompt'
      ? sectionText
      : `${BRAINSTORM_PROMPT_SECTION_LABELS[key]}: ${sectionText}`];
  }).join('\n');
}
