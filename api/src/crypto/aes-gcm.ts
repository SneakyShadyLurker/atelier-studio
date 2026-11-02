import { importRawKeyFromHex } from './hex-key';

// The data key is the master bytes verbatim (importRawKeyFromHex), NOT an
// HKDF subkey. This MUST stay identity: deriving it differently makes every
// already-encrypted BYOK row undecryptable with no recovery path. Key
// separation from the fingerprint HMAC is achieved by deriving *that* key
// via HKDF instead (see crypto/hex-key.ts, crypto/fingerprint.ts).
export async function importMasterKey(hex: string): Promise<CryptoKey> {
  return importRawKeyFromHex(hex, { name: 'AES-GCM' }, ['encrypt', 'decrypt'], 'master key');
}

export interface Ciphertext {
  ciphertext: Uint8Array<ArrayBuffer>; // payload + 16-byte auth tag
  nonce: Uint8Array<ArrayBuffer>; // 12 bytes
}

export async function encrypt(
  key: CryptoKey,
  plaintext: string,
  additionalData?: Uint8Array,
): Promise<Ciphertext> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, ...(additionalData ? { additionalData } : {}) },
    key,
    enc,
  );
  return { ciphertext: new Uint8Array(out), nonce };
}

export async function decrypt(
  key: CryptoKey,
  data: Readonly<Ciphertext>,
  additionalData?: Uint8Array,
): Promise<string> {
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.nonce, ...(additionalData ? { additionalData } : {}) },
    key,
    data.ciphertext,
  );
  return new TextDecoder().decode(out);
}
