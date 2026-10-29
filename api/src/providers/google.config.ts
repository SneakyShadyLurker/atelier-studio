export const GOOGLE_MODEL_IDS = [
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-lite-image',
] as const;
export type GoogleModelId = (typeof GOOGLE_MODEL_IDS)[number];

// Hardcoded request-shape constants. These are code-reviewed adapter policy,
// not operator-tunable environment.
export const GOOGLE_IMAGE_SIZE = '2K' as const;
export const GOOGLE_SAFETY_THRESHOLD = 'OFF' as const;

// gemini-3.1-flash-lite-image only supports 1K output (2K/4K are documented
// as unsupported for this model, unlike the other two Google models).
export const GOOGLE_IMAGE_SIZE_OVERRIDES: Partial<Record<GoogleModelId, typeof GOOGLE_IMAGE_SIZE | '1K'>> = {
  'gemini-3.1-flash-lite-image': '1K',
};

export const GOOGLE_SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
] as const;

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GOOGLE_AUTH_HEADER = 'x-goog-api-key';
