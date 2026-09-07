import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const INITIALISATION_VECTOR_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;

/**
 * Reversible protection for secrets the platform must be able to read back,
 * such as the signing key shared with the WhatsApp provider. Those cannot be
 * hashed, because verifying an incoming signature requires the original value.
 *
 * The stored layout is: initialisation vector, authentication tag, ciphertext.
 */
export function encryptSecret(plainText: string, encryptionKey: string): Buffer {
  const key = Buffer.from(encryptionKey, 'base64');
  const initialisationVector = randomBytes(INITIALISATION_VECTOR_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, initialisationVector);

  const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);

  return Buffer.concat([initialisationVector, cipher.getAuthTag(), cipherText]);
}

export function decryptSecret(payload: Buffer, encryptionKey: string): string {
  const key = Buffer.from(encryptionKey, 'base64');
  const initialisationVector = payload.subarray(0, INITIALISATION_VECTOR_BYTES);
  const authenticationTag = payload.subarray(
    INITIALISATION_VECTOR_BYTES,
    INITIALISATION_VECTOR_BYTES + AUTHENTICATION_TAG_BYTES,
  );
  const cipherText = payload.subarray(INITIALISATION_VECTOR_BYTES + AUTHENTICATION_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, initialisationVector);
  decipher.setAuthTag(authenticationTag);

  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
}
