/* Maps a spreadsheet's headers to the fields we care about, then validates every
   row. Nothing is dropped: every data row comes back with is_valid + errors +
   warnings so the frontend can show a truthful, fully-flagged preview. */

// Header synonyms → canonical field. Matched case-insensitively after trimming
// and collapsing spaces/underscores.
const FIELD_SYNONYMS = {
  email: ['email', 'e mail', 'email address', 'mail', 'recipient', 'recipient email', 'to', 'work email'],
  name: ['name', 'full name', 'contact', 'contact name', 'recipient name', 'first name', 'person'],
  company: ['company', 'company name', 'organization', 'organisation', 'org', 'business', 'account'],
}

// Pragmatic email check: something@something.tld, no spaces. Not RFC-perfect on
// purpose — it catches the typos this preview exists to surface.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

/* Decide which column index feeds each field. First matching header wins.
   Returns { email, name, company } as column indexes (or null if not found). */
export function buildColumnMap(headers) {
  const normalized = headers.map(normalizeHeader)
  const map = { email: null, name: null, company: null }

  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    for (let i = 0; i < normalized.length; i++) {
      if (map[field] != null) break
      if (synonyms.includes(normalized[i])) map[field] = i
    }
  }
  return map
}

/* A human-readable version of the mapping for the preview UI, e.g.
   { email: "Email Address", name: "Full Name", company: null } */
export function describeColumnMap(headers, columnMap) {
  const described = {}
  for (const field of Object.keys(columnMap)) {
    const idx = columnMap[field]
    described[field] = idx == null ? null : headers[idx] ?? null
  }
  return described
}

function cell(row, idx) {
  if (idx == null) return ''
  return (row[idx] ?? '').toString().trim()
}

/* Validate all rows against the column map. Returns an array of recipient
   objects ready to insert, each carrying its validation verdict. Duplicate
   emails (case-insensitive) are flagged as a warning on the later occurrences —
   the row stays valid, but the user is told so nobody gets mailed twice. */
export function validateRows(headers, rows, columnMap) {
  const mappedIdx = new Set(Object.values(columnMap).filter((v) => v != null))
  const seenEmails = new Map() // lowercased email → first row_number

  return rows.map((row, i) => {
    const email = cell(row, columnMap.email)
    const name = cell(row, columnMap.name) || null
    const company = cell(row, columnMap.company) || null

    // Preserve any unmapped columns so the user doesn't lose data.
    const extra = {}
    headers.forEach((h, idx) => {
      if (!mappedIdx.has(idx)) {
        const value = cell(row, idx)
        if (value) extra[h || `column_${idx + 1}`] = value
      }
    })

    const errors = []
    const warnings = []

    if (!email) {
      errors.push('missing_email')
    } else if (!EMAIL_RE.test(email)) {
      errors.push('invalid_email')
    } else {
      const key = email.toLowerCase()
      if (seenEmails.has(key)) {
        warnings.push('duplicate_email')
      } else {
        seenEmails.set(key, i + 1)
      }
    }

    return {
      row_number: i + 1,
      email: email || null,
      name,
      company,
      extra,
      is_valid: errors.length === 0,
      errors,
      warnings,
    }
  })
}

/* Turn error/warning codes into readable messages for the API/UI. */
export const ISSUE_LABELS = {
  missing_email: 'Missing email address',
  invalid_email: 'Email address looks invalid',
  duplicate_email: 'Duplicate email (already appears above)',
}
