import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';
import type { RawInferOp } from './inferTypes';
import { sliceJsonObject } from './lenientJson';

const Label = z.string().trim().min(1).check(maxUtf16Length(64));
const TagList = z.array(Label).min(1).max(50);
const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('createDimension'), name: Label, tags: TagList }).strict(),
  z.object({ op: z.literal('addTags'), dimIdx: z.number().int().min(0), tags: TagList }).strict(),
  z.object({ op: z.literal('renameDimension'), dimIdx: z.number().int().min(0), newName: Label }).strict(),
  z.object({
    op: z.literal('mergeDimensions'),
    fromIdx: z.number().int().min(0),
    intoIdx: z.number().int().min(0),
    tagMap: z.record(Label, Label),
  }).strict(),
  z.object({
    op: z.literal('assignOptionTags'),
    listIdx: z.number().int().min(0),
    optionIdx: z.number().int().min(0),
    tags: z.array(z.object({ dimName: Label, label: Label }).strict()).min(1).max(50),
  }).strict(),
  z.object({
    op: z.literal('addOption'),
    listIdx: z.number().int().min(0),
    value: Label,
    tags: z.array(z.object({ dimName: Label, label: Label }).strict()).min(1).max(50),
  }).strict(),
]);

export function parseInferPayload(raw: string): RawInferOp[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sliceJsonObject(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const ops = (parsed as { ops?: unknown }).ops;
  if (!Array.isArray(ops) || ops.length > 500) return null;
  const out: RawInferOp[] = [];
  for (const o of ops) {
    const r = OpSchema.safeParse(o);
    if (r.success) out.push(r.data);
  }
  return out;
}
