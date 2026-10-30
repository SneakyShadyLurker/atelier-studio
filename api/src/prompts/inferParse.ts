import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';
import { sliceJsonObject } from './lenientJson';

const Label = z.string().trim().min(1).check(maxUtf16Length(64));
const TagList = z.array(Label).min(1).max(50);
const Index = z.union([z.number(), z.string().regex(/^\d+$/)]).pipe(z.coerce.number<string | number>().int().min(0));
const TagRef = z.object({ dimName: Label, label: Label });
const AddOptionOpSchema = z.object({
  op: z.literal('addOption'), listIdx: Index, value: Label,
  tags: z.array(TagRef).min(1).max(50),
});

export const InferOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('createDimension'), name: Label, tags: TagList }),
  z.object({ op: z.literal('addTags'), dimIdx: Index, tags: TagList }),
  z.object({ op: z.literal('renameDimension'), dimIdx: Index, newName: Label }),
  z.object({
    op: z.literal('mergeDimensions'),
    fromIdx: Index,
    intoIdx: Index,
    tagMap: z.record(Label, Label),
  }),
  z.object({
    op: z.literal('assignOptionTags'),
    listIdx: Index,
    optionIdx: Index,
    tags: z.array(TagRef).min(1).max(50),
  }),
  AddOptionOpSchema,
]);

export type RawInferOp = z.output<typeof InferOpSchema>;
const InferPayloadSchema = z.object({ ops: z.array(InferOpSchema).max(500) });
const RescuePayloadSchema = z.object({ ops: z.array(AddOptionOpSchema).min(1).max(1) }).strict();
const { $schema: _dialect, ...rescueSchema } = z.toJSONSchema(RescuePayloadSchema, { target: 'draft-7', io: 'output' });
export const RESCUE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'dimension_rescue', strict: true, schema: rescueSchema },
} as const;

export function parseInferPayload(raw: string): RawInferOp[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sliceJsonObject(raw));
  } catch {
    return null;
  }
  // Schemas strip harmless extra keys and normalize digit-string indices.
  // Operations may depend on one another. Validate the complete proposal:
  // silently removing malformed operations can manufacture partial success
  // or turn an invalid response into an apparently intentional empty result.
  const result = InferPayloadSchema.safeParse(parsed);
  return result.success ? result.data.ops : null;
}
