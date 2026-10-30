import type {
  AdminModel,
  AdminProvider,
  ConnectionReport,
  ListedModel,
  TestReport,
  TextModelCapabilities,
  TextModelHints,
  TextProtocol,
  TextProviderConnectionTestRequest,
  TextRoutingResponse,
  TextTask,
  TextTokenField,
  TextWriterMode,
} from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, apiPath, requestJson } from './client';

// Admin text-provider API (spec § 10.2). Every route answers 404 to anyone
// outside TEXT_PROVIDER_ADMINS, which the hook reads as "gated". Not
// persisted: `shouldDehydrateQuery` (lib/persister.ts) keeps only its own key
// families, and availability is live data.
export const textAdminKeys = {
  all: () => ['text-admin'] as const,
  providers: () => ['text-admin', 'providers'] as const,
  routing: () => ['text-admin', 'routing'] as const,
};

const adminRetry = (failureCount: number, error: Error): boolean => {
  if (error instanceof ApiError && (error.status === 404 || !error.retryable)) return false;
  return failureCount < 2;
};

export const textProvidersOpts = () =>
  queryOptions({
    queryKey: textAdminKeys.providers(),
    queryFn: () => requestJson<{ providers: readonly AdminProvider[] }>('/text-providers'),
    // Availability comes from the server's 60s poller; follow its cadence.
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: adminRetry,
  });

export const textRoutingOpts = () =>
  queryOptions({
    queryKey: textAdminKeys.routing(),
    queryFn: () => requestJson<TextRoutingResponse>('/text-routing'),
    retry: adminRetry,
  });

function jsonInit(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export interface ProviderCreateBody {
  readonly name: string;
  readonly protocol: TextProtocol;
  readonly baseUrl: string;
  readonly preset?: string;
  readonly apiKey?: string;
  readonly tokenField?: TextTokenField;
  readonly listModels?: boolean;
}

export interface ProviderPatchBody {
  readonly name?: string;
  readonly protocol?: TextProtocol;
  readonly baseUrl?: string;
  readonly preset?: string | null;
  /** A string replaces the stored key; null removes it. */
  readonly apiKey?: string | null;
  readonly tokenField?: TextTokenField;
  readonly listModels?: boolean;
  readonly enabled?: boolean;
}

export interface ModelPatchBody extends Partial<TextModelCapabilities> {
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly screenRequests?: boolean;
  readonly sortOrder?: number;
}

export interface NewModelBody {
  readonly modelId: string;
  readonly displayName?: string;
  readonly hints?: TextModelHints;
}

export const createProvider = (body: ProviderCreateBody) =>
  requestJson<AdminProvider>('/text-providers', jsonInit('POST', body));

export const patchProvider = (id: string, body: ProviderPatchBody) =>
  requestJson<AdminProvider>(apiPath('/text-providers/:id', { id }), jsonInit('PATCH', body));

export const deleteProvider = (id: string) =>
  requestJson<{ ok: true }>(apiPath('/text-providers/:id', { id }), jsonInit('DELETE'));

/** "Check again": one availability poll for the provider, then its fresh row. */
export const refreshProvider = (id: string) =>
  requestJson<AdminProvider>(apiPath('/text-providers/:id/refresh', { id }), jsonInit('POST'));

export const testDraftConnection = (body: TextProviderConnectionTestRequest) =>
  requestJson<ConnectionReport>('/text-providers/test', jsonInit('POST', body));

export const testSavedConnection = (id: string, probeModelId?: string) =>
  requestJson<ConnectionReport>(
    apiPath('/text-providers/:id/test', { id }),
    jsonInit('POST', probeModelId === undefined ? undefined : { probeModelId }),
  );

export const listAvailableModels = (id: string) =>
  requestJson<{ models: readonly ListedModel[]; listUnsupported: boolean }>(
    apiPath('/text-providers/:id/models/available', { id }),
  );

export const addModels = (id: string, models: readonly NewModelBody[]) =>
  requestJson<readonly AdminModel[]>(apiPath('/text-providers/:id/models', { id }), jsonInit('POST', { models }));

export const patchModel = (id: string, mid: string, body: ModelPatchBody) =>
  requestJson<AdminModel>(apiPath('/text-providers/:id/models/:mid', { id, mid }), jsonInit('PATCH', body));

export const deleteModel = (id: string, mid: string) =>
  requestJson<{ ok: true }>(apiPath('/text-providers/:id/models/:mid', { id, mid }), jsonInit('DELETE'));

export const testModel = (id: string, mid: string) =>
  requestJson<TestReport>(apiPath('/text-providers/:id/models/:mid/test', { id, mid }), jsonInit('POST'));

export const putRoutingDefault = (scope: 'default' | TextTask, modelId: string | null) =>
  requestJson<TextRoutingResponse>(apiPath('/text-routing/defaults/:scope', { scope }), jsonInit('PUT', { modelId }));

export interface WriterBody {
  /** null clears the writer. */
  readonly modelId: string | null;
  /** Omitted = the server default, 'prefer'. */
  readonly mode?: TextWriterMode;
}

export const putRoutingWriter = (imageModelId: string, body: WriterBody) =>
  requestJson<TextRoutingResponse>(apiPath('/text-routing/writers/:imageModelId', { imageModelId }), jsonInit('PUT', body));
