// Named starting points for a new text provider. Data only: a preset fills the
// form (protocol, base URL, token field) and is never consulted again after
// the provider is created. URLs per spec docs/specs/byo-text-providers.md § 6.3.
import type { TextProtocol, TextTokenField } from './index';

export interface TextPreset {
  readonly id: string;
  readonly label: string;
  readonly protocol: TextProtocol;
  /** Empty for the two Custom presets: the admin types the address. */
  readonly baseUrl: string;
  readonly keyRequired: boolean;
  /** Null for Anthropic, which has one fixed field. */
  readonly tokenField: TextTokenField | null;
  readonly listModels: boolean;
  /** One plain-English line shown under the preset. */
  readonly hint: string;
}

export const TEXT_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    tokenField: 'max_completion_tokens',
    listModels: true,
    hint: 'OpenAI\'s own API. Needs an API key from platform.openai.com.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyRequired: true,
    tokenField: null,
    listModels: true,
    hint: 'Claude models through Anthropic\'s API. Needs an API key from console.anthropic.com.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    tokenField: 'max_completion_tokens',
    listModels: true,
    hint: 'One key for models from many companies. Its model list also says which models accept images.',
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyRequired: true,
    tokenField: 'max_completion_tokens',
    listModels: true,
    hint: 'Fast hosted open models. Needs an API key from console.groq.com.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (OpenAI-compatible)',
    protocol: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyRequired: true,
    tokenField: 'max_tokens',
    listModels: true,
    hint: 'Gemini models through Google\'s OpenAI-compatible endpoint. Needs a key from Google AI Studio.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    keyRequired: false,
    tokenField: 'max_tokens',
    listModels: true,
    hint: 'Runs on this machine. No key needed unless you set one.',
  },
  {
    id: 'lm-studio',
    label: 'LM Studio',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    keyRequired: false,
    tokenField: 'max_tokens',
    listModels: true,
    hint: 'Runs on this machine once LM Studio\'s server is started. No key needed unless you set one.',
  },
  {
    id: 'custom-openai',
    label: 'Custom OpenAI-compatible',
    protocol: 'openai-compatible',
    baseUrl: '',
    keyRequired: false,
    tokenField: 'max_completion_tokens',
    listModels: true,
    hint: 'Any other server that speaks the OpenAI chat API, such as a proxy or vLLM. Enter its address.',
  },
  {
    id: 'custom-anthropic',
    label: 'Custom Anthropic-compatible',
    protocol: 'anthropic',
    baseUrl: '',
    keyRequired: false,
    tokenField: null,
    listModels: true,
    hint: 'Any other server that speaks the Anthropic Messages API. Enter its address.',
  },
] as const satisfies readonly TextPreset[];

export type TextPresetId = (typeof TEXT_PRESETS)[number]['id'];
