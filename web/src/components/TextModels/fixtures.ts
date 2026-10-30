import type { AdminModel, AdminProvider, TextModelUsage, TextRoutingResponse } from '@atelier/shared';

// Shared test fixtures for the Text models view.

const NO_USAGE: TextModelUsage = { isDefault: false, tasks: [], writers: [], userPicks: 0 };

export function adminModel(overrides: Partial<AdminModel> & Pick<AdminModel, 'id' | 'modelId' | 'displayName'>): AdminModel {
  return {
    providerId: 'p-cli',
    vision: false,
    maxImages: null,
    structuredOutput: 'none',
    reasoningLevels: [],
    reasoningDefault: null,
    temperature: null,
    topP: null,
    fixedOutputTokens: null,
    latencyProfile: 'standard',
    promptVariant: 'generic',
    enabled: true,
    screenRequests: false,
    sortOrder: 0,
    status: 'available',
    verifiedAt: null,
    lastTest: null,
    usage: NO_USAGE,
    ...overrides,
  };
}

export function adminProvider(overrides: Partial<AdminProvider> & Pick<AdminProvider, 'id' | 'name'>): AdminProvider {
  return {
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8317/v1',
    preset: null,
    auth: 'none',
    tokenField: 'max_completion_tokens',
    listModels: true,
    enabled: true,
    listedCount: null,
    warnings: [],
    models: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export const KIMI = adminModel({
  id: 'm-kimi',
  modelId: 'kimi-latest',
  displayName: 'Kimi K3',
  vision: true,
  structuredOutput: 'json_schema',
  reasoningLevels: ['low', 'high', 'max'],
  usage: { isDefault: true, tasks: ['ai-fill'], writers: ['gpt-image-2.5-sunburst'], userPicks: 3 },
});

export const GLM = adminModel({
  id: 'm-glm',
  modelId: 'glm-5.3',
  displayName: 'GLM 5.3',
  structuredOutput: 'json_object',
  reasoningLevels: ['low', 'high'],
  status: 'offline',
});

export const SCOUT = adminModel({
  id: 'm-scout',
  providerId: 'p-ollama',
  modelId: 'llama4:scout',
  displayName: 'Llama 4 Scout',
  vision: true,
  status: 'unknown',
});

export const PROVIDERS: readonly AdminProvider[] = [
  adminProvider({ id: 'p-cli', name: 'CLIProxyAPI', auth: 'env', envVar: 'CLIPROXY_TOKEN', models: [KIMI, GLM] }),
  adminProvider({
    id: 'p-ollama',
    name: 'Ollama on this Mac',
    baseUrl: 'http://localhost:11434/v1',
    models: [SCOUT],
  }),
  adminProvider({
    id: 'p-openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'stored',
    fingerprint: 'sha256:9f2cab12',
    warnings: ['byok-not-configured'],
  }),
];

export const ROUTING: TextRoutingResponse = {
  defaults: { default: 'm-kimi', byTask: { 'ai-fill': 'm-kimi' } },
  writers: {},
  imageModels: [
    { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' },
    { id: 'krea-2', label: 'Krea 2' },
  ],
};
