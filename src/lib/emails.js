/* Provider emails are sometimes built from a name with accents
   ("jorge.yáñez@…"). Almost no mail server accepts that, while the plain-ASCII
   form usually is the real mailbox, so transliterate — and count the result as
   a guess. Anything still not a plain address is dropped rather than stored. */
export function cleanEmail(raw) {
  if (!raw) return { email: null, altered: false }
  const original = String(raw).trim().toLowerCase()
  const email = original.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (!/^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) {
    return { email: null, altered: false }
  }
  return { email, altered: email !== original }
}
