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
