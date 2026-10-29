import type { Config } from '../config';
import { findModel } from '../providers/registry';
import { aiFillTextProviderForConfig, cliproxyTextForConfig } from '../providers/textRouting';
import { isSunburstModel } from '../prompts/gptSystemPrompt';

/** Library operations can carry an image context without changing their own task. */
export function imageTextProvider(config: Config, modelId: string | undefined) {
  const entry = modelId === undefined ? undefined : findModel(modelId, config);
  return isSunburstModel(entry?.model.id)
    ? aiFillTextProviderForConfig(config, 'gpt')
    : cliproxyTextForConfig(config);
}
