import type { ApiErrorCode } from '@atelier/shared';
import type { Config } from '../config';
import type { TextResolveFailure } from '../routing/textModelResolver';
import type { TextServices } from '../routing/textServices';
import type { TextModelRecord } from '../db/textProviders';
import { findModel } from './registry';
import { textModelProviderFor } from './text/registry';
import type { TextModelProvider } from './text/textModel';

// Every text call resolves a model (`c.var.text.resolve`) and then asks for
// that row's feature provider here. The registry caches per row and revision
// and honors the test override.

/** The feature provider for the model the resolver picked. */
export function textProviderForResolved(
  config: Config,
  text: Pick<TextServices, 'store'>,
  model: Pick<TextModelRecord, 'id'>,
): TextModelProvider {
  return textModelProviderFor(config, text.store, model.id);
}

/**
 * The resolver's `imageModelId` for a request's image-model id: only a
 * registered model selects a prompt writer; anything else routes without one.
 */
export function imageModelRouting(config: Config, modelId: string | undefined): { readonly imageModelId?: string } {
  const entry = modelId === undefined ? null : findModel(modelId, config);
  return entry ? { imageModelId: entry.model.id } : {};
}

/** Error envelope for a call no text model can serve (spec § 7). Always a 409. */
export interface TextModelFailureBody {
  readonly error: string;
  readonly code: ApiErrorCode;
}

const FAILURES: Readonly<Record<TextResolveFailure, TextModelFailureBody>> = {
  'not-configured': {
    error: 'No text model is set up. An admin can add one under Text models.',
    code: 'TEXT_MODEL_NOT_CONFIGURED',
  },
  'no-vision-model': {
    error: 'None of the available text models accepts images. Remove the reference images or ask an admin to enable image input on a model.',
    code: 'TEXT_MODEL_NO_VISION',
  },
  'pin-unavailable': {
    error: 'The text model set for this image model is turned off or unavailable. Ask an admin to check Text models.',
    code: 'TEXT_MODEL_UNAVAILABLE',
  },
};

export function textModelFailureBody(reason: TextResolveFailure): TextModelFailureBody {
  return FAILURES[reason];
}
