import { importDerivedKeyFromHex } from './hex-key';

// Distinct HKDF info label keeps this fingerprint key cryptographically
// separate from the AES-GCM data key, which uses the raw master verbatim.
const FINGERPRINT_HKDF_INFO = 'atelier-byok-fingerprint-hmac/v1';

export async function importHmacKey(hex: string): Promise<CryptoKey> {
  return importDerivedKeyFromHex(
    hex,
    FINGERPRINT_HKDF_INFO,
    { name: 'HMAC', hash: 'SHA-256' },
    ['sign'],
    'hmac master key',
  );
}

export async function fingerprint(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(plaintext),
  );
  return Buffer.from(sig).subarray(0, 8).toString('hex');
}
