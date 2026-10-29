import type { BundleCommon, TemplateConflict } from '@atelier/shared';
import { isRecord, isStringArray } from '../lib/guards';

export function isBundleCommon(value: unknown): value is BundleCommon & Record<string, unknown> {
  return isRecord(value)
    && typeof value.key === 'string'
    && typeof value.title === 'string'
    && typeof value.detail === 'string'
    && (value.impact === undefined || typeof value.impact === 'string')
    && typeof value.destructive === 'boolean'
    && typeof value.defaultChecked === 'boolean'
    && isStringArray(value.dependsOn);
}

export function isTemplateConflict(value: unknown): value is TemplateConflict {
  return isRecord(value)
    && typeof value.templateName === 'string'
    && typeof value.reason === 'string'
    && isStringArray(value.culpritBundleKeys)
    && typeof value.rescueAttempted === 'boolean'
    && (value.culpritKind === 'local' || value.culpritKind === 'non-local');
}
