/**
 * Device identity: the one credential the browser extension holds.
 *
 * R2 says the extension bundle carries NO secrets — no provider key, no vault
 * material, nothing that would be worth reading out of a shipped .crx. The single
 * exception is this token, and it is the exception because it is not a secret of
 * ours: it identifies one browser, it reaches exactly three endpoints, and the
 * operator can revoke it from the dashboard the moment it leaks.
 *
 * SHA-256, NOT A PASSWORD HASH. A device token is 256 bits of randomness, so
 * there is no dictionary to slow an attacker down against and no work factor
 * worth paying for; a slow KDF would only make every extension poll expensive.
 * The plaintext is returned ONCE, at registration, and never stored (the same
 * rule the vault follows for provider credentials).
 *
 * The hash is stored in `devices.token_hash`, which carries a UNIQUE index, so
 * lookup is by hash rather than by scanning and comparing.
 */

const TOKEN_BYTES = 32;

/** base64url, so the token survives a header, a URL and an operator's clipboard. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A fresh token and the hash to store. The caller must show `token` to the
 * operator exactly once and must not log it.
 */
export async function newDeviceToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const token = toBase64Url(bytes);
  return { token, hash: await hashDeviceToken(token) };
}
