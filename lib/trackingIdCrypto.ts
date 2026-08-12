import { createPrivateKey, privateDecrypt, constants } from 'crypto'

function getPrivateKey() {
  const raw = process.env.TRACKING_ID_PRIVATE_KEY
  if (!raw) throw new Error('TRACKING_ID_PRIVATE_KEY env var is not set')
  // Support both real newlines (from .env.local multiline) and escaped \n (from single-line env vars)
  return createPrivateKey(raw.replace(/\\n/g, '\n'))
}

/**
 * Decrypts a base64-encoded RSA-OAEP ciphertext produced by the INSURVAS-CRM browser client.
 * Throws if the ciphertext is invalid or the private key is missing.
 */
export function decryptTrackingId(ciphertext: string): string {
  const key = getPrivateKey()
  const decrypted = privateDecrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(ciphertext, 'base64'),
  )
  return decrypted.toString('utf8')
}

/**
 * Like decryptTrackingId but falls back to returning the raw value if decryption fails.
 * Use this for fields that may contain legacy plaintext (pre-encryption rows).
 */
export function decryptTrackingIdSafe(ciphertext: string): string {
  try {
    return decryptTrackingId(ciphertext)
  } catch {
    return ciphertext
  }
}
