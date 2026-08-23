/* Maps a spreadsheet's headers to the fields we care about, then validates every
   row. Nothing is dropped: every data row comes back with is_valid + errors +
   warnings so the frontend can show a truthful, fully-flagged preview.

   One sheet row can produce SEVERAL recipients. Sheets often carry addresses in
   columns beyond the mapped email one (email2, "Contact 3", or a column with no
   header at all). Each unique address in a row becomes its own record, sharing
   that row's website/name/cc/bcc/extra, so a row with four addresses mails four
   people instead of one. See expandRowEmails for the rules. */

// Header synonyms → canonical field. Matched case-insensitively after trimming
// and collapsing spaces/underscores.
const FIELD_SYNONYMS = {
  email: ['email', 'e mail', 'email address', 'mail', 'recipient', 'recipient email', 'to', 'work email'],
  name: ['name', 'full name', 'contact', 'contact name', 'recipient name', 'first name', 'person'],
  website: ['website', 'web site', 'site', 'url', 'website url', 'web address', 'domain', 'company website', 'company', 'company name', 'organization', 'organisation', 'org', 'business', 'account'],
  cc: ['cc', 'carbon copy', 'copy', 'cc email', 'cc emails'],
  bcc: ['bcc', 'blind carbon copy', 'blind copy', 'bcc email', 'bcc emails'],
}

// Pragmatic email check: something@something.tld, no spaces. Not RFC-perfect on
// purpose — it catches the typos this preview exists to surface.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/* Ceiling on recipients generated from a single sheet row. Real sheets never
   come close; this only stops a pathologically wide file from multiplying
   50k rows into millions of inserts. Overflow is reported, never silent. */
export const MAX_EMAILS_PER_ROW = 50

/* Split a cell into candidate addresses. Separators are comma, semicolon,
   pipe, slash and any whitespace, which covers every hand-typed list we've
   seen. A leading `mailto:` (common when Excel stores a hyperlink) is stripped
   so it can't end up baked into the stored address. */
function splitAddresses(raw) {
  if (!raw) return []
  return String(raw)
    .split(/[,;|/\s]+/)
    .map((a) => a.trim().replace(/^mailto:/i, ''))
    .filter(Boolean)
}

/* Every address in a cell — but only when the cell is NOTHING BUT addresses.
   A prose cell ("ping john@acme.com to get access") returns nothing on
   purpose: we promote dedicated address columns to recipients, we never
   harvest addresses out of free text. */
function cellAddresses(raw) {
  const parts = splitAddresses(raw)
  if (parts.length === 0) return []
  return parts.every((p) => EMAIL_RE.test(p)) ? parts : []
}

/* A CC/BCC cell may list several addresses (comma- or semicolon-separated).
   Keep only the well-formed ones, joined comma-separated for the MIME header;
   invalid fragments are dropped so a stray typo in CC can never fail the send
   to the primary recipient. Returns null when nothing valid remains. */
function sanitizeAddressList(raw) {
  if (!raw) return null
  const valid = String(raw)
    .split(/[,;]+/)
    .map((a) => a.trim())
    .filter((a) => a && EMAIL_RE.test(a))
  return valid.length ? valid.join(', ') : null
}

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

/* Decide which column index feeds each field. First matching header wins.
   Returns { email, name, website } as column indexes (or null if not found). */
export function buildColumnMap(headers) {
  const normalized = headers.map(normalizeHeader)
  const map = { email: null, name: null, website: null, cc: null, bcc: null }

  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    for (let i = 0; i < normalized.length; i++) {
      if (map[field] != null) break
      if (synonyms.includes(normalized[i])) map[field] = i
    }
  }
  console.log('column map', map, 'from headers', headers)
  return map
}

/* A human-readable version of the mapping for the preview UI, e.g.
   { email: "Email Address", name: "Full Name", website: null } */
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

/* Every address a single row contributes, in column order, de-duplicated
   case-insensitively — the mapped email column first, then any unmapped column
   that holds nothing but addresses.

   The mapped name/website columns are skipped because they aren't recipients,
   and cc/bcc are skipped deliberately: those are copy targets the user already
   told us how to treat, so promoting them to their own records would mail the
   same person twice under two different roles.

   Also reports which column indexes were consumed as addresses, so the caller
   can keep them out of `extra` — they're represented by the records themselves
   now, and leaving them in would hand every generated record a
   {{email_2}}-style token pointing at a sibling. */
function expandRowEmails(row, scanIdx, primaryIdx) {
  const emails = []
  const seenInRow = new Set()
  const consumedIdx = new Set()

  const push = (addr) => {
    const key = addr.toLowerCase()
    if (seenInRow.has(key)) return
    seenInRow.add(key)
    emails.push(addr)
  }

  for (const addr of cellAddresses(cell(row, primaryIdx))) push(addr)

  for (const idx of scanIdx) {
    const found = cellAddresses(cell(row, idx))
    if (found.length === 0) continue
    consumedIdx.add(idx)
    for (const addr of found) push(addr)
  }

  return { emails, consumedIdx }
}

/* Validate all rows against the column map. Returns an array of recipient
   objects ready to insert, each carrying its validation verdict.

   A row yields one record per unique address it contains (see expandRowEmails),
   or exactly one flagged record when it has no usable address at all — so an
   unusable row is still shown to the user rather than vanishing.

   `row_number` is a running record counter, not the sheet line: it has to stay
   unique because it's the React key in the preview and the stable tiebreak for
   keyset pagination. The originating sheet line is kept as `source_row`.

   Duplicate emails (case-insensitive) are flagged as a warning on the later
   occurrences — the record stays valid, but the user is told so nobody gets
   mailed twice. */
export function validateRows(headers, rows, columnMap) {
  const mappedIdx = new Set(Object.values(columnMap).filter((v) => v != null))
  const seenEmails = new Map() // lowercased email → first source_row

  // Widest row in the file: sheets often carry unlabelled columns past the end
  // of the header row, and those are exactly where stray addresses hide.
  const width = rows.reduce((max, row) => Math.max(max, row.length), headers.length)
  const columnName = []
  const scanIdx = []
  for (let idx = 0; idx < width; idx++) {
    columnName.push((headers[idx] || '').trim() || `column_${idx + 1}`)
    if (!mappedIdx.has(idx)) scanIdx.push(idx)
  }

  const out = []
  let recordNo = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const sourceRow = i + 1
    const name = cell(row, columnMap.name) || null
    const website = cell(row, columnMap.website) || null
    const cc = sanitizeAddressList(cell(row, columnMap.cc))
    const bcc = sanitizeAddressList(cell(row, columnMap.bcc))

    const { emails, consumedIdx } = expandRowEmails(row, scanIdx, columnMap.email)

    // Preserve any unmapped column that wasn't consumed as an address, so the
    // user doesn't lose data. Built once and shared by this row's records —
    // nothing downstream mutates it.
    const extra = {}
    for (const idx of scanIdx) {
      if (consumedIdx.has(idx)) continue
      const value = cell(row, idx)
      if (value) extra[columnName[idx]] = value
    }

    const base = { source_row: sourceRow, name, website, cc, bcc, extra }

    if (emails.length === 0) {
      // Nothing usable anywhere in the row — emit one record carrying the fault.
      const raw = cell(row, columnMap.email)
      out.push({
        ...base,
        row_number: ++recordNo,
        email: raw || null,
        is_valid: false,
        errors: [raw ? 'invalid_email' : 'missing_email'],
        warnings: [],
      })
      continue
    }

    const overflow = emails.length > MAX_EMAILS_PER_ROW
    const kept = overflow ? emails.slice(0, MAX_EMAILS_PER_ROW) : emails

    for (let n = 0; n < kept.length; n++) {
      const email = kept[n]
      const warnings = []
      if (n > 0) warnings.push('derived_email')
      if (overflow && n === 0) warnings.push('extra_emails_truncated')

      const key = email.toLowerCase()
      if (seenEmails.has(key)) warnings.push('duplicate_email')
      else seenEmails.set(key, sourceRow)

      out.push({
        ...base,
        row_number: ++recordNo,
        email,
        is_valid: true,
        errors: [],
        warnings,
      })
    }
  }

  return out
}

/* Turn error/warning codes into readable messages for the API/UI. */
export const ISSUE_LABELS = {
  missing_email: 'Missing email address',
  invalid_email: 'Email address looks invalid',
  duplicate_email: 'Duplicate email (already appears above)',
  derived_email: 'Extra address found in another column on the same row',
  extra_emails_truncated: `Row had more than ${MAX_EMAILS_PER_ROW} addresses; the rest were skipped`,
}
