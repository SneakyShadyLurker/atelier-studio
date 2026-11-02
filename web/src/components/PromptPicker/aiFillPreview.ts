import { parseAiFillTokens } from '@atelier/shared/ai-fill';

export interface PreviewSegment {
  readonly kind: 'text' | 'aiFill';
  readonly value: string; // text content, or the literal instruction for aiFill
  readonly start: number; // offset into the assembled preview — stable render key
}

// Split a preview string into plain-text runs and inert ai-fill chips. The chip
// shows the LITERAL instruction — it resolves only at Generate, so preview and
// Generate can't drift. Reuses the shared parser (root-exported via
// `@atelier/shared/ai-fill`), never `findTokens` (which is a separate subpath).
export function toPreviewSegments(text: string): PreviewSegment[] {
  const { slots, staticSegments } = parseAiFillTokens(text);
  const out: PreviewSegment[] = [];
  let offset = 0;
  for (let i = 0; i < staticSegments.length; i++) {
    const seg = staticSegments[i] ?? '';
    if (seg.length > 0) out.push({ kind: 'text', value: seg, start: offset });
    offset += seg.length;
    const slot = slots[i];
    if (slot) {
      out.push({ kind: 'aiFill', value: slot.instruction, start: offset });
      offset += slot.instruction.length;
    }
  }
  return out;
}
