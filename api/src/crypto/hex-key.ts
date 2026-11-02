// Single source of truth for the "64 hex characters (32 bytes)" raw-key rule
// shared by BYOK_ENCRYPTION_KEY config validation, the AES-GCM envelope key,
// and the HMAC fingerprint key. A drift between the config-load check and the
// importKey check produces the unrecoverable-decrypt failure documented in
// docs/deployment.md § BYOK master-key loss (validates at boot, throws at
// first encrypt/decrypt).
//
// Key separation: the AES-GCM data key uses importRawKeyFromHex (the master
// bytes verbatim) and MUST stay identity — changing how the data key is
// derived makes every already-encrypted BYOK row undecryptable with no
// recovery path (the master-key-loss class). The HMAC
// fingerprint key uses importDerivedKeyFromHex (an HKDF subkey under a
// distinct info label) so the two primitives never share key material; the
// fingerprint is display-only and recomputed on every put, so re-deriving it
// is safe and needs no migration.

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;

export function isValidHexKey(value: string): boolean {
  return HEX_KEY_RE.test(value);
}

// Param types derived from the runtime so the api workspace (no DOM lib) does
// not need the DOM global type names (KeyUsage, AlgorithmIdentifier, …).
type ImportKeyParams = Parameters<typeof crypto.subtle.importKey>;

export async function importRawKeyFromHex(
  hex: string,
  algorithm: ImportKeyParams[2],
  usages: ImportKeyParams[4],
  label: string,
): Promise<CryptoKey> {
  if (!HEX_KEY_RE.test(hex)) {
    throw new Error(`${label} must be 64 hex characters (32 bytes)`);
  }
  return crypto.subtle.importKey('raw', Buffer.from(hex, 'hex'), algorithm, false, usages);
}

export async function importDerivedKeyFromHex(
  hex: string,
  info: string,
  algorithm: ImportKeyParams[2],
  usages: ImportKeyParams[4],
  label: string,
): Promise<CryptoKey> {
  if (!HEX_KEY_RE.test(hex)) {
    throw new Error(`${label} must be 64 hex characters (32 bytes)`);
  }
  const ikm = await crypto.subtle.importKey('raw', Buffer.from(hex, 'hex'), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    ikm,
    256,
  );
  return crypto.subtle.importKey('raw', bits, algorithm, false, usages);
}
