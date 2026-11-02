import { PROMPT_LIBRARY_NAME_MAX_CHARS } from '@atelier/shared/prompt-limits';

function tidy(value: string): string {
  return value.replace(/[\s\p{P}]+$/u, '').trim();
}

export function deriveTemplateName(prompt: string): string {
  const firstLine = (prompt.split('\n', 1)[0] ?? '').trim();
  if (firstLine === '') return '';
  if (firstLine.length <= PROMPT_LIBRARY_NAME_MAX_CHARS) {
    const tidied = tidy(firstLine);
    return tidied === '' ? firstLine.slice(0, PROMPT_LIBRARY_NAME_MAX_CHARS) : tidied;
  }
  const slice = firstLine.slice(0, PROMPT_LIBRARY_NAME_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace >= 24 ? slice.slice(0, lastSpace) : slice;
  const tidied = tidy(cut);
  return tidied === '' ? cut : tidied;
}
