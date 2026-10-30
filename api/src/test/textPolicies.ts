import { loadConfig } from '../config';
import { cliproxyTextPolicies, type CliproxyTextPolicies } from '../providers/cliproxyText';

const defaults = loadConfig({
  CLIPROXY_BASE_URL: 'http://127.0.0.1:1',
  CLIPROXY_TOKEN: 'stub',
  DATA_DIR: '/tmp/atelier-test',
});

// The production text policies (attempt counts, timeouts, one breaker each)
// with millisecond backoff, so retry paths stay fast. Fresh breakers per call.
export function testTextPolicies(overrides: Partial<CliproxyTextPolicies> = {}): CliproxyTextPolicies {
  return {
    ...cliproxyTextPolicies({ ...defaults, RESILIENT_INITIAL_BACKOFF_MS: 1, RESILIENT_MAX_BACKOFF_MS: 1 }, 'standard'),
    ...overrides,
  };
}
