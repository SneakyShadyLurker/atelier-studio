import { z } from 'zod';
import { NameSchema, uuidParam } from './_schema';

export const CreateBody = z.object({ name: NameSchema }).strict();

export const PatchBody = z.object({ name: NameSchema }).strict();

export const CollectionParamSchema = uuidParam('id');

export const ReorderBody = z.object({
  orderedIds: z.array(z.uuid()).min(1).max(50),
}).strict();

export const PatchBatchBody = z.object({
  collectionId: z.union([z.uuid(), z.null()]).optional(),
  pinned: z.boolean().optional(),
}).strict()
  .refine((body) => body.collectionId !== undefined || body.pinned !== undefined, {
    message: 'at least one of collectionId or pinned required',
  });
