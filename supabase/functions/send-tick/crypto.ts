// AES-256-GCM decryption for Google refresh tokens, matching how the Express
// backend encrypts them in backend/src/lib/crypto.js. The stored format is
//   iv(hex) : authTag(hex) : ciphertext(hex)
// Node stores the 16-byte GCM auth tag separately; WebCrypto expects it appended
// to the ciphertext, so we concatenate the two before decrypting.

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function decryptToken(payload: string | null, keyHex: string): Promise<string | null> {
  if (!payload) return null
  const [ivHex, tagHex, dataHex] = payload.split(':')
  if (!ivHex || !tagHex || !dataHex) return null

  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(keyHex),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )

  const iv = hexToBytes(ivHex)
  const ciphertext = hexToBytes(dataHex)
  const tag = hexToBytes(tagHex)

  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext, 0)
  combined.set(tag, ciphertext.length)

  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined)
  return new TextDecoder().decode(plain)
}

// Encrypt a fresh access token in the same iv:authTag:ciphertext hex format,
// so the Express backend's decrypt() can read back whatever we cache here.
export async function encryptToken(plaintext: string, keyHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'AES-GCM' }, false, ['encrypt'])

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(plaintext)
  // WebCrypto appends the 16-byte GCM tag to the ciphertext; split it back out
  // to match Node's separate iv:authTag:ciphertext layout.
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data))
  const ciphertext = encrypted.slice(0, encrypted.length - 16)
  const tag = encrypted.slice(encrypted.length - 16)

  return [bytesToHex(iv), bytesToHex(tag), bytesToHex(ciphertext)].join(':')
}
