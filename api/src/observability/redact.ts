// Secret redaction patterns + helper, shared between orchestrator/sanitize.ts
// (provider-error logging) and observability/logger.ts (custom err serializer).
//
// Coarse enough to catch common token shapes — false positives are fine;
// false negatives (token leaks) are not. Any new secret type seen in a stack
// trace or provider response should land here once and propagate to both
// callsites.

export function redactSecrets(text: string): string {
  return text
    .replace(/(bearer\s+)([A-Za-z0-9._+/=-]{8,})/gi, (_match, prefix: string) => `${prefix}…[redacted]`)
    .replace(/(authorization["':\s=]+)([^\s"',]+)/gi, (match) => `${match.slice(0, 8)}…[redacted]`)
    .replace(/(?:sk-ant-[A-Za-z0-9_-]{8,})/gi, '[redacted]')
    .replace(/(?:sk-[A-Za-z0-9._-]{8,})/gi, '[redacted]')
    .replace(/(?:AIza[A-Za-z0-9_-]{35})/g, '[redacted]')
    .replace(/(?:gh[pousr]_[A-Za-z0-9]{16,})/g, '[redacted]')
    .replace(/(?:A[KS]IA[A-Z0-9]{12,})/g, '[redacted]')
    .replace(/(x-atelier-proxy-key["':\s=]+)([^\s"',]+)/gi, (_match, prefix: string) => `${prefix}…[redacted]`)
    .replace(/(BYOK_ENCRYPTION_KEY["':\s=]+)([0-9a-fA-F]{64})/g, (_match, prefix: string) => `${prefix}…[redacted]`);
}
