import type { AiFillBackend } from '@atelier/shared';
import type { Config } from '../config';
import {
  cliproxyTextForBackend,
  cliproxyTextForConfig,
  type CliproxyTextProvider,
} from './cliproxyText';

export { cliproxyTextForConfig };

// Provider for ai-fill — BOTH Generate and the Prompt Library "Simulate"
// preview. The route selects one explicit backend for the entire fill; no
// branch falls through to the generic text model or another backend.
// cliproxyTextForBackend honors the test-provider override.
export function aiFillTextProviderForConfig(
  config: Config,
  backend: AiFillBackend,
): CliproxyTextProvider {
  return cliproxyTextForBackend(config, backend);
}

// Provider for the MiniMax H3 I2V motion-prompt enhancement (submit-time).
// It uses the same explicit per-backend CLIProxy router as ai-fill. This
// helper only applies the feature kill switch and selected backend. Motion
// enhancement is unconditionally Kimi and excluded from the override feature.
export function motionEnhanceTextProviderForConfig(
  config: Config,
  backend: AiFillBackend,
): CliproxyTextProvider | null {
  if (!config.I2V_MOTION_ENHANCE) return null;
  return aiFillTextProviderForConfig(config, backend);
}
