/**
 * Vault crypto — AES-256-GCM.
 *
 * The key is a Worker secret and never reaches D1; only the sealed parts do
 * (ciphertext, iv, auth_tag), which is what `provider_credentials` stores. The
 * `last4` column exists so the UI can show which key is loaded without the
 * plaintext ever leaving this module — and a decrypted secret is never written
 * to a response, a log, or `error_log.message`.
 *
 * A fresh random IV per seal is not optional: GCM loses all confidentiality and
 * integrity if an IV repeats under the same key, so the IV is generated here
 * rather than accepted from a caller.
 */

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit, the GCM standard

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  last4: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key);
  if (raw.byteLength !== KEY_BYTES) {
    // Fail loudly at the boundary. A 16-byte key would silently produce AES-128
    // and a short key would throw somewhere far less obvious than here.
    throw new Error(`VAULT_KEY must decode to ${KEY_BYTES} bytes, got ${raw.byteLength}`);
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** The last four characters, for display. Short secrets get masked entirely. */
export function last4(plaintext: string): string {
  return plaintext.length >= 4 ? plaintext.slice(-4) : '';
}

export async function sealSecret(plaintext: string, base64Key: string): Promise<SealedSecret> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const buffer = new Uint8Array(sealed);

  // WebCrypto appends the 16-byte tag to the ciphertext; store it separately so
  // the columns match the schema and a raw read cannot be mistaken for usable
  // ciphertext.
  const tagLength = 16;
  const body = buffer.slice(0, buffer.length - tagLength);
  const tag = buffer.slice(buffer.length - tagLength);

  return {
    ciphertext: toBase64(body),
    iv: toBase64(iv),
    auth_tag: toBase64(tag),
    last4: last4(plaintext),
  };
}

export async function openSecret(
  sealed: { ciphertext: string; iv: string; auth_tag: string },
  base64Key: string,
): Promise<string> {
  const key = await importKey(base64Key);
  const body = fromBase64(sealed.ciphertext);
  const tag = fromBase64(sealed.auth_tag);
  const combined = new Uint8Array(body.length + tag.length);
  combined.set(body, 0);
  combined.set(tag, body.length);

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.iv) },
    key,
    combined,
  );
  return new TextDecoder().decode(plain);
}

/**
 * Generate a VAULT_KEY. Used once, when the secret is first installed; the
 * value is piped straight into `wrangler secret put` and is never printed.
 */
export function generateVaultKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** A device token: 32 random bytes, shown once, stored only as a SHA-256 hash. */
export function generateDeviceToken(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
