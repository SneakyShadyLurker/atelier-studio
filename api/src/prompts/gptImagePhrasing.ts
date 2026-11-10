export function isGptImageModelId(modelId: string): boolean {
  return modelId.includes('gpt-image');
}

export type ImageModelTarget = 'gemini' | 'gpt' | 'krea' | 'moss' | 'h3image' | 'other';

// Single mutually-exclusive classifier. Every model-conditional fragment of a
// meta prompt must key off the SAME target value so a malformed or composite
// model id can never yield a hybrid prompt.
export function classifyImageModelTarget(modelId: string): ImageModelTarget {
  if (modelId.includes('gemini')) return 'gemini';
  if (isGptImageModelId(modelId)) return 'gpt';
  if (modelId.includes('krea')) return 'krea';
  if (modelId.includes('moss')) return 'moss';
  // Only the image row: the MiniMax H3 video ids (`minimax-h3-i2v`, `-t2v`) stay 'other'.
  if (modelId.includes('h3-image')) return 'h3image';
  return 'other';
}

// The local open-weights lanes (Krea 2, MOSS Image, MiniMax H3 Image) share one
// text-routing rule: Kimi writes for them by default, and enhance only targets
// them for users who may use local models. Their phrasing contracts stay separate.
export function isLocalOpenWeightsTarget(
  target: ImageModelTarget | null,
): target is 'krea' | 'moss' | 'h3image' {
  return target === 'krea' || target === 'moss' || target === 'h3image';
}
