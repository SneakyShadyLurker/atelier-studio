import type { ApplyDimensionsRequest, DiagnoseSelectionRequest, DraftTemplateRequest, DraftVariableListRequest, RescueDimensionsRequest } from '@atelier/shared';
import type { AssertWire, MatchesWire } from '../validation/wireBinding';
import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';
import {
  LIST_DESCRIPTION_MAX_CHARS,
  PROMPT_LIBRARY_NAME_MAX_CHARS,
  TEMPLATE_DESCRIPTION_MAX_CHARS,
} from '@atelier/shared/prompt-limits';
import { PROMPT_ARRAY_TRANSPORT_MAX, TEMPLATE_BODY_HARD_MAX } from '../prompts/limits';
import { NameSchema, uuidParam } from './_schema';

export const IdParam = uuidParam('id');

export const TemplateCreate = z.object({
  name: NameSchema,
  body: z.string().min(1).check(maxUtf16Length(TEMPLATE_BODY_HARD_MAX)),
  notes: z.string().check(maxUtf16Length(4_000)).optional(),
}).strict();

export const TemplatePatch = z.object({
  name: NameSchema.optional(),
  body: z.string().min(1).check(maxUtf16Length(TEMPLATE_BODY_HARD_MAX)).optional(),
  notes: z.string().check(maxUtf16Length(4_000)).nullable().optional(),
}).strict().refine(
  (b) => b.name !== undefined || b.body !== undefined || b.notes !== undefined,
  { message: 'at least one of name, body, notes required' },
);

export const ListCreate = z.object({ name: NameSchema }).strict();
export const ListPatch = z.object({ name: NameSchema }).strict();

export const DraftListBody = z.object({
  modelId: z.string().min(1).max(200).optional(),
  name: NameSchema,
  existing: z.array(z.string().trim().min(1).check(maxUtf16Length(2_000))).max(PROMPT_ARRAY_TRANSPORT_MAX),
  description: z.string().trim().min(1).check(maxUtf16Length(LIST_DESCRIPTION_MAX_CHARS)).optional(),
}).strict();

export const OptionsReplace = z.object({
  options: z.array(z.object({
    value: z.string().trim().min(1).check(maxUtf16Length(2_000)),
    tagIds: z.array(z.uuid()).max(50)
      .refine((a) => new Set(a).size === a.length, { message: 'tagIds must be unique' }),
    sortOrder: z.number().int().min(0),
    weight: z.number().int().min(0).max(100).default(1),
  })).max(PROMPT_ARRAY_TRANSPORT_MAX),
}).strict();

export const OptionPatch = z.object({
  value: z.string().trim().min(1).check(maxUtf16Length(2_000)).optional(),
  tagIds: z.array(z.uuid()).max(50)
    .refine((a) => new Set(a).size === a.length, { message: 'tagIds must be unique' })
    .optional(),
  sortOrder: z.number().int().min(0).optional(),
  weight: z.number().int().min(0).max(100).optional(),
}).strict().refine(
  (v) => v.value !== undefined || v.tagIds !== undefined || v.sortOrder !== undefined || v.weight !== undefined,
  { message: 'at least one field must be supplied' },
);

export const OptionIdParam = z.object({
  listId: z.uuid(),
  optionId: z.uuid(),
});

export const DimensionCreate = z.object({ name: NameSchema }).strict();
export const DimensionPatch = z.object({ name: NameSchema }).strict();

export const TagsReplace = z.object({
  tags: z.array(z.object({
    id: z.uuid().optional(),
    label: z.string().trim().min(1).check(maxUtf16Length(PROMPT_LIBRARY_NAME_MAX_CHARS)),
    sortOrder: z.number().int().min(0),
  })).max(PROMPT_ARRAY_TRANSPORT_MAX),
}).strict();

export const OrderBody = z.object({
  orderedIds: z.array(z.uuid()).min(1).max(PROMPT_ARRAY_TRANSPORT_MAX),
}).strict();

export const ApplyDimensions = z.object({
  proposalId: z.uuid(),
  acceptedBundleKeys: z.array(z.string().min(1).check(maxUtf16Length(200))).max(2_000),
  acceptUnsatisfiableTemplates: z.array(z.string().min(1).check(maxUtf16Length(PROMPT_LIBRARY_NAME_MAX_CHARS))).max(2_000).optional(),
  overrideCoherence: z.boolean().optional(),
}).strict();

export const RescueDimensions = z.object({
  modelId: z.string().min(1).max(200).optional(),
  proposalId: z.uuid(),
  templateName: z.string().min(1).check(maxUtf16Length(200)),
}).strict();

export const DiagnoseSelection = z.object({
  proposalId: z.uuid(),
  acceptedBundleKeys: z.array(z.string().min(1).check(maxUtf16Length(200))).max(2_000),
}).strict();

export const DraftTemplateRequestSchema = z.object({
  modelId: z.string().min(1).max(200).optional(),
  name: NameSchema,
  existingBody: z.string().check(maxUtf16Length(TEMPLATE_BODY_HARD_MAX)),
  description: z.string().trim().min(1).check(maxUtf16Length(TEMPLATE_DESCRIPTION_MAX_CHARS)).optional(),
}).strict();

// Only modelId provides image context. Server unconditionally recomputes
// the prior diagnosis from its own DB on every call — never trusts the
// client. (This closes prompt injection via user-controlled
// template/list/dimension names in the previous priorDiagnosis path.)
export const InferRequestBody = z.looseObject({ modelId: z.string().min(1).max(200).optional() });

type _DraftVariableListRequestWire = AssertWire<MatchesWire<typeof DraftListBody, DraftVariableListRequest>>;
type _DraftTemplateRequestWire = AssertWire<MatchesWire<typeof DraftTemplateRequestSchema, DraftTemplateRequest>>;
type _RescueDimensionsRequestWire = AssertWire<MatchesWire<typeof RescueDimensions, RescueDimensionsRequest>>;
type _DiagnoseSelectionRequestWire = AssertWire<MatchesWire<typeof DiagnoseSelection, DiagnoseSelectionRequest>>;
type _ApplyDimensionsRequestWire = AssertWire<MatchesWire<typeof ApplyDimensions, ApplyDimensionsRequest>>;
