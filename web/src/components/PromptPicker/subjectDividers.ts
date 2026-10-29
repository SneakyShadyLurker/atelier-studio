import type { VarOccurrence } from '../../lib/promptResolver';

export type AxisListItem =
  | { kind: 'divider'; label: string; subject: number | null }
  | { kind: 'axis'; occurrence: VarOccurrence };

export function buildAxisListItems(axes: readonly VarOccurrence[]): AxisListItem[] {
  const subjects: (number | null)[] = [];
  const seen = new Set<string>();
  for (const a of axes) {
    const tag = a.subject === null ? 'scene' : String(a.subject);
    if (seen.has(tag)) continue;
    seen.add(tag);
    subjects.push(a.subject);
  }
  // Scene first, then ascending numeric subjects.
  subjects.sort((x, y) => {
    if (x === null) return -1;
    if (y === null) return 1;
    return x - y;
  });
  const out: AxisListItem[] = [];
  for (const subject of subjects) {
    const label = subject === null ? 'SCENE' : `SUBJECT ${subject}`;
    out.push({ kind: 'divider', label, subject });
    for (const a of axes) {
      if (a.subject === subject) out.push({ kind: 'axis', occurrence: a });
    }
  }
  return out;
}
