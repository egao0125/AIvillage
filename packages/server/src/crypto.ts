/**
 * AES-256-GCM encryption for sensitive values (API keys) stored in the database.
 *
 * Encrypted format: "<iv_hex>:<tag_hex>:<ciphertext_hex>"
 *   - IV:         16 random bytes, unique per encryption
 *   - Tag:        16 bytes GCM authentication tag (detects tampering)
 *   - Ciphertext: variable length
 *
 * Environment variable:
 *   ENCRYPTION_KEY — 64-character hex string (32 bytes)
 *   Generate:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Migration safety:
 *   decryptApiKey() detects whether a stored value is in encrypted format.
 *   If not (plaintext legacy value), it returns the value as-is.
 *   This allows gradual migration without wiping existing data.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;   // bytes
const TAG_LEN = 16;  // bytes

// Matches "<hex>:<hex>:<hex>" — our encrypted format.
// Rejects plaintext API keys (sk-ant-..., sk-...) which don't contain colons.
const ENCRYPTED_RE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

function loadKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) return null;
  if (hex.length !== 64) {
    console.error(
      '[Crypto] ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ' +
      'Current value has length ' + hex.length + '. Key ignored — storing plaintext.',
    );
    return null;
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext API key.
 * Returns the plaintext unchanged if ENCRYPTION_KEY is not set.
 */
export function encryptApiKey(plaintext: string): string {
  const key = loadKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();  // always TAG_LEN bytes with aes-256-gcm

  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypt a stored API key.
 * - If the value is in encrypted format, decrypt and return plaintext.
 * - If the value is plaintext (legacy/migration), return as-is.
 * - If decryption fails (wrong key, tampered data), returns '' and logs an error.
 */
export function decryptApiKey(stored: string): string {
  if (!ENCRYPTED_RE.test(stored)) {
    // Not in encrypted format — plaintext legacy value, return as-is.
    return stored;
  }

  const key = loadKey();
  if (!key) {
    console.error(
      '[Crypto] ENCRYPTION_KEY is not set but an encrypted API key was found in the database. ' +
      'Cannot decrypt. Set ENCRYPTION_KEY to restore access.',
    );
    return '';
  }

  try {
    const parts = stored.split(':');
    if (parts.length !== 3) throw new Error('Unexpected encrypted format (expected 3 parts)');
    const [ivHex, tagHex, ciphertextHex] = parts;

    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plaintext =
      decipher.update(Buffer.from(ciphertextHex, 'hex')).toString('utf8') +
      decipher.final('utf8');
    return plaintext;
  } catch (err) {
    console.error('[Crypto] Failed to decrypt API key:', (err as Error).message);
    return '';
  }
}

/**
 * Returns true if ENCRYPTION_KEY is set and valid.
 * Used at startup to warn operators when the key is missing.
 */
export function isEncryptionConfigured(): boolean {
  return loadKey() !== null;
}
