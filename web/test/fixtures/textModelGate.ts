import type { QueryClient } from '@tanstack/react-query';
import type { TextModelsResponse } from '@atelier/shared';
import { textModelKeys } from '../../src/api/textModels';
import { textAdminKeys } from '../../src/api/textProviders';

const oneModel: TextModelsResponse = {
  models: [{ id: 'writer', displayName: 'Writer', providerName: 'Local', vision: false, reasoningLevels: [], status: 'available' }],
  tasks: [],
  defaults: { byTask: {} },
  writers: {}, lockedWriters: [],
};

/**
 * Settles the AI triggers' text-model gate (`useTextModelGate`) from the cache
 * so a suite that counts its own requests never sees the gate's reads.
 * Defaults: one configured model, an admin viewer.
 */
export function seedTextModelGate(client: QueryClient, { models = oneModel }: { models?: TextModelsResponse } = {}): void {
  client.setQueryData(textModelKeys.all(), models);
  client.setQueryData(textAdminKeys.providers(), { providers: [] });
}
