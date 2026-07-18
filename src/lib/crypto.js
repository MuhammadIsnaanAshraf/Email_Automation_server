import crypto from 'node:crypto'
import { env } from '../config/env.js'

/* Google refresh tokens are long-lived credentials to a user's inbox, so we
   never store them in plaintext. We encrypt with AES-256-GCM using the key from
   TOKEN_ENCRYPTION_KEY. The stored string is  iv:authTag:ciphertext  (hex). */

const ALGORITHM = 'aes-256-gcm'

function getKey() {
  const key = Buffer.from(env.tokenEncryptionKey, 'hex')
  if (key.length !== 32) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes as 64 hex chars. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  return key
}

export function encrypt(plaintext) {
  if (plaintext == null) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':')
}

export function decrypt(payload) {
  if (payload == null) return null
  const [ivHex, tagHex, dataHex] = String(payload).split(':')
  if (!ivHex || !tagHex || !dataHex) return null
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return decrypted.toString('utf8')
}
