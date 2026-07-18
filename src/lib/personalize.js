/* Personalization engine — shared by the live preview and (later) the sending
   module, so "what you see in the preview" is exactly "what gets sent".

   A template's subject/body may contain {{placeholders}}. Each placeholder is
   resolved against a recipient row into a value. Tokens are matched
   case-insensitively; spaces and hyphens in a token are treated like
   underscores, so {{First Name}}, {{first_name}} and {{FIRST-NAME}} are one. */

// {{ token }} — token is letters/numbers/space/underscore/hyphen.
const TOKEN_RE = /\{\{\s*([\w\s-]+?)\s*\}\}/g

export function normalizeToken(token) {
  return String(token || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

/* Unique, normalized placeholder names used across the given strings, in first
   -seen order. e.g. extractVariables("Hi {{First Name}}", "{{company}}") →
   ['first_name', 'company']. */
export function extractVariables(...texts) {
  const seen = new Set()
  const out = []
  for (const text of texts) {
    if (!text) continue
    for (const match of String(text).matchAll(TOKEN_RE)) {
      const key = normalizeToken(match[1])
      if (key && !seen.has(key)) {
        seen.add(key)
        out.push(key)
      }
    }
  }
  return out
}

/* Turn a recipient row (from the `recipients` table) into a flat map of token →
   value. Provides the mapped columns (email/name/company), sensible derived
   tokens (first_name/last_name), and every unmapped column from `extra`. */
export function buildContext(recipient = {}) {
  const ctx = {}
  const put = (key, value) => {
    if (value == null || value === '') return
    ctx[normalizeToken(key)] = String(value)
  }

  put('email', recipient.email)
  put('name', recipient.name)
  put('full_name', recipient.name)
  put('company', recipient.company)

  // Derive first / last name from a full name.
  if (recipient.name) {
    const parts = String(recipient.name).trim().split(/\s+/)
    put('first_name', parts[0])
    if (parts.length > 1) put('last_name', parts[parts.length - 1])
  }

  // Any columns the upload didn't map (e.g. city, role) live in `extra`.
  if (recipient.extra && typeof recipient.extra === 'object') {
    for (const [k, v] of Object.entries(recipient.extra)) put(k, v)
  }

  return ctx
}

/* The token names a recipient row can actually fill — used to show the user
   which variables are available for a given list. */
export function availableTokens(recipient = {}) {
  return Object.keys(buildContext(recipient))
}

/* Replace every {{token}} with its value from `context`.
   - keepUnknown=true  → leave unresolved tokens as literal {{token}} (preview,
     so the user notices missing data)
   - keepUnknown=false → drop unresolved tokens to '' (actual send) */
export function renderText(text, context = {}, { keepUnknown = false } = {}) {
  if (!text) return ''
  return String(text).replace(TOKEN_RE, (whole, raw) => {
    const key = normalizeToken(raw)
    if (key in context) return context[key]
    return keepUnknown ? whole : ''
  })
}

/* Render a full template ({subject, body}) against one recipient. Returns the
   filled subject/body plus which tokens couldn't be resolved. */
export function renderTemplate({ subject = '', body = '' }, recipient = {}, opts = {}) {
  const context = buildContext(recipient)
  const used = extractVariables(subject, body)
  const missing = used.filter((t) => !(t in context))
  return {
    subject: renderText(subject, context, opts),
    body: renderText(body, context, opts),
    context,
    variables: used,
    missing,
  }
}
