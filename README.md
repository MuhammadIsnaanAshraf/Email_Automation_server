# FlowState Backend

Express API for the FlowState product. Modules implemented so far:

- **Module 1 — Authentication:** login + Gmail-send authorization in one Google
  consent.
- **Module 2 — Sheet Upload:** upload a CSV/Excel recipient list, validate it
  server-side, preview flagged rows, then confirm to save.
- **Module 3 — Templates & Campaigns:** reusable personalized templates + a live
  preview; a campaign pairs a template with a list.
- **Module 4 — Sending Engine:** schedules every recipient's send time up front,
  then a pg_cron-driven Edge Function sends what's due — throttled, fair across
  users, no persistent server. (See the Module 4 section at the bottom.)

Setup (install / Supabase / Google / env / run) is below, followed by a section
per module.

---

## Module 1: Authentication

Express API for **login + Gmail-send authorization in one Google consent**, with
users, sessions, and Gmail connection status stored in Supabase.

There is no email/password auth — "Continue with Google" handles both sign-up and
log-in, and the same consent grants permission to send email through the user's
Gmail account later.

## Stack

- **Express** (ESM) — HTTP API
- **Google OAuth 2.0** (`googleapis`) — identity + `gmail.send` scope
- **Supabase** (`@supabase/supabase-js`, service-role) — data store
- Server-side sessions via an httpOnly cookie; refresh tokens encrypted at rest

## Setup

### 1. Install

```bash
cd backend
npm install
```

### 2. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In the **SQL editor**, run [`db/schema.sql`](db/schema.sql) (Module 1), then
   [`db/02_sheet_upload.sql`](db/02_sheet_upload.sql) (Module 2).
3. Copy **Project Settings → API → Project URL** and the **service_role** key
   into `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
   The service-role key is secret — backend only, never the browser.

### 3. Google Cloud Console

1. Create a project → **APIs & Services**.
2. **Enable the Gmail API** (APIs & Services → Library → Gmail API).
3. **OAuth consent screen**: External, add the scopes
   `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
   `.../auth/gmail.send`. While unverified, add yourself as a **test user**.
4. **Credentials → Create OAuth client ID → Web application**. Add the
   **Authorized redirect URI**:
   ```
   http://localhost:4000/auth/google/callback
   ```
5. Put the client id/secret into `.env`
   (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).

### 4. Env

`.env` is created for you (with a generated `TOKEN_ENCRYPTION_KEY`). Fill in the
Google + Supabase values. See [`.env.example`](.env.example) for the full list.

### 5. Run

```bash
npm run dev     # auto-reload
# or
npm start
```

Server: `http://localhost:4000`.

## Endpoints

| Method | Path                    | Auth | Purpose |
|--------|-------------------------|------|---------|
| GET    | `/health`               | —    | Liveness check |
| GET    | `/auth/google`          | —    | Start Google sign-in + consent (login **and** signup) |
| GET    | `/auth/google/callback` | —    | Google redirects here; creates/recognizes user, stores Gmail connection, sets session, redirects to frontend |
| GET    | `/auth/reconnect`       | —    | Re-run consent to repair a broken/expired Gmail connection |
| GET    | `/auth/me`              | ✅   | Current user + Gmail connection status |
| POST   | `/auth/logout`          | —    | Destroy session, clear cookie |

### Frontend wiring

- **"Continue with Google" button** → redirect the browser to
  `GET {BACKEND_URL}/auth/google`. (A `fetch` won't work — it's a full-page
  redirect to Google.)
- After success the backend redirects to `FRONTEND_URL/`. On error it redirects
  to `FRONTEND_URL/login?error=...`.
- On app load, call `GET /auth/me` **with credentials**
  (`fetch(url, { credentials: 'include' })`) to know if the user is signed in and
  whether Gmail is connected.

### Connection status (the "reconnect" requirement)

`/auth/me` returns a `connection` object:

```json
{
  "status": "connected | expired | revoked | error | disconnected",
  "canSendEmail": true,
  "needsReconnect": false,
  "scopes": ["...gmail.send"],
  "lastError": null
}
```

When `needsReconnect` is `true`, the frontend should show a banner with a
"Reconnect Google" button pointing at `/auth/reconnect`. The email-sending
module calls `getValidAccessToken(userId)` (in
[`src/services/connections.js`](src/services/connections.js)); if Google has
revoked the grant it flips `status` to `revoked` so the user is told clearly
instead of the send failing silently.

## Data model

- **users** — one row per person, keyed by Google `sub` (`google_id`).
- **google_connections** — encrypted refresh/access tokens + `status`.
- **sessions** — server-side sessions; the cookie only holds the opaque id.

RLS is enabled with no public policies — only the service-role backend can read
these tables.

---

# Module 3: Templates & Campaigns

Reusable email **templates** with personalization placeholders, a **live preview**
that fills them from real uploaded data, and **campaigns** — a template paired with
a recipient list — which are the unit handed off to the sending module.

Run [`db/03_templates_campaigns.sql`](db/03_templates_campaigns.sql) in the Supabase
SQL editor (after `01` and `02`). No new environment variables.

## Concepts

- **Template** — a saved `{ name, subject, body }`. The body/subject may contain
  `{{placeholders}}` (e.g. `{{first_name}}`, `{{company}}`, or any column from an
  uploaded list). Detected placeholder names are stored on the row as `variables`.
- **Personalization** — [`src/lib/personalize.js`](src/lib/personalize.js) is the
  single engine shared by the preview and the sender, so *what you preview is what
  gets sent*. Tokens are case-insensitive; `{{First Name}}` == `{{first_name}}`.
  It derives `first_name`/`last_name` from a full name and exposes every unmapped
  column (from a recipient's `extra`) as a token too.
- **Campaign** — `createCampaign` pairs a template (or ad-hoc subject/body) with a
  list and **snapshots** the subject/body + recipient count onto the campaign row.
  Later edits to (or deletion of) the template never mutate an existing campaign.

## Endpoints

| Method | Path                        | Purpose |
|--------|-----------------------------|---------|
| GET    | `/templates`                | List the user's saved templates |
| POST   | `/templates`                | Create a template `{ name, subject, body }` |
| GET    | `/templates/:id`            | Get one template |
| PUT    | `/templates/:id`            | Update `{ name?, subject?, body? }` (recomputes `variables`) |
| DELETE | `/templates/:id`            | Delete a template |
| POST   | `/templates/preview`        | Render `{ subject, body, listId? }` against a **real** row from the list (first valid recipient); falls back to a built-in sample. Returns filled `subject`/`body`, `availableTokens`, and `missing` (used-but-unfillable tokens) |
| GET    | `/campaigns`                | List campaigns (embeds template + list names) |
| POST   | `/campaigns`                | Create `{ templateId?, subject?, body?, listId, scheduledAt?, frequency? }` |
| GET    | `/campaigns/:id`            | Get one campaign |
| GET    | `/campaigns/:id/recipients` | Valid recipients the campaign will send to (sender handoff) |
| PATCH  | `/campaigns/:id/status`     | Transition status (`draft`→`scheduled`→`sending`→`sent`/`failed`/`paused`/`canceled`) |
| DELETE | `/campaigns/:id`            | Delete a campaign |

All routes require a signed-in session and are scoped to the owner. A campaign
refuses to be created against a list with zero valid recipients, so you can never
schedule a send to nobody.

## Frontend wiring

- **Template Builder** (`/templates`) loads saved templates + lists, renders the
  live preview via `POST /templates/preview` (real data), saves via `POST/PUT
  /templates`, and creates a campaign via `POST /campaigns`.
- **Campaign Queue** (`/campaigns`) lists real campaigns and drives status/delete.
- API helpers live in [`frontend/src/lib/api.js`](../frontend/src/lib/api.js).

---

## Module 2: Sheet Upload

Upload a spreadsheet of recipients, validate it **server-side**, review a preview
with invalid rows **clearly flagged**, then confirm to save. Nothing is finalized
until the user confirms, and invalid rows are never silently dropped.

- **Formats:** CSV, TSV, and Excel (`.xlsx` / `.xls`). Max 5 MB, 50k rows.
- **Column detection:** headers are auto-mapped to `email` (required), `name`,
  and `company` (both optional) using common synonyms. Any other columns are kept
  in `extra` so no data is lost. The detected mapping is returned so the user can
  catch a wrongly-labeled column.
- **Validation:** each row is checked for a present, well-formed email. Issues are
  attached per row as `error` (blocking: `missing_email`, `invalid_email`) or
  `warning` (non-blocking: `duplicate_email`). A row's `is_valid` reflects only
  blocking errors.
- **Two-phase save:** an upload creates a `draft` list; `confirm` promotes it to
  `ready` for the sending module. Confirm is refused if there are zero valid rows.

### Endpoints (all require a session cookie)

| Method | Path                    | Purpose |
|--------|-------------------------|---------|
| POST   | `/lists/upload`         | Upload + parse + validate → **draft** + preview. `multipart/form-data`, field `file`, optional `name`. |
| GET    | `/lists`                | All of the user's lists (metadata + counts). |
| GET    | `/lists/:id`            | One list + recipients. Query: `filter=all\|valid\|invalid`, `page`, `pageSize`. |
| POST   | `/lists/:id/confirm`    | Promote draft → **ready**. |
| PATCH  | `/lists/:id`            | Rename. Body: `{ name }`. |
| DELETE | `/lists/:id`            | Delete a list (recipients cascade). |

### Upload response shape

```jsonc
{
  "list": { "id": "…", "status": "draft", "total_rows": 7, "valid_rows": 4, "invalid_rows": 3, "column_map": { "email": "Email Address", "name": "Full Name", "company": "Company" } },
  "preview": {
    "columnMap": { "email": "Email Address", "name": "Full Name", "company": "Company" },
    "detectedHeaders": ["Full Name", "Email Address", "Company", "Notes"],
    "totals": { "total": 7, "valid": 4, "invalid": 3 },
    "sample": [ /* first 50 rows, each decorated with `issues[]` */ ],
    "invalidRows": [ /* the flagged rows, up front for review */ ]
  }
}
```

Each recipient row includes `issues: [{ code, label, severity }]` — ready to
render in the preview without the frontend re-deriving anything.

### Data model

- **recipient_lists** — one row per uploaded list: `status` (`draft`/`ready`/
  `archived`), `column_map`, `detected_headers`, and the valid/invalid counts.
- **recipients** — one row per data line: `email`/`name`/`company`, `extra`
  (unmapped columns), `is_valid`, `errors[]`, `warnings[]`, `row_number`.

Both are RLS-locked (service-role only). Files are parsed **in memory** and never
written to disk.

---

## Module 4: Sending Engine (Scheduling & Throttling)

The part that actually sends — **in the background, with no persistent server or
worker**. A `pg_cron` job ticks every minute and calls a Supabase **Edge
Function** ([`supabase/functions/send-tick`](../supabase/functions/send-tick))
that claims what's due and sends it via each user's Gmail token.

### How it works

1. **Schedule up front.** `POST /campaigns/:id/schedule` computes a send time for
   **every** recipient the moment you schedule — paced (`frequency`) and daily
   capped (`users.daily_send_limit`). 50 people at 1/min → now, +1m, +2m, … These
   land as rows in `campaign_sends`. ([`src/lib/scheduleSends.js`](src/lib/scheduleSends.js))
2. **Tick → claim.** Each minute the Edge Function calls `claim_due_sends(...)`,
   a Postgres function that selects due rows **across all users**, caps how many
   per user (anti-burst), and atomically flips them to `sending` with
   `FOR UPDATE SKIP LOCKED`. Two overlapping ticks can therefore **never** grab
   the same row → no double-sends.
3. **Send, fairly + spaced.** Claimed rows are grouped by user; **users run
   concurrently**, but each user's own emails go out one at a time with a small
   gap (`SEND_INTRA_PASS_DELAY_MS`). A recipient's turn depends only on its own
   `scheduled_at`, never on which user uploaded first.
4. **Fail soft.** A bad address fails just that row (marked `failed`) and the
   campaign continues. Transient errors (429/5xx) and connection problems
   reschedule with backoff up to `SEND_MAX_ATTEMPTS`; a revoked grant flips the
   Gmail connection to `revoked` (so Module 1's reconnect banner shows).
5. **Roll up.** After each pass, `refresh_campaign_progress(...)` recomputes
   `sent_count`/`failed_count` and marks the campaign `sent` when nothing's left.

### API (all require a session)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/campaigns/:id/schedule` | Assign send times & enqueue. Body: `{ startAt?, frequency?, dailyLimit? }` |
| GET  | `/campaigns/:id/progress` | Counts by status + `nextSendAt` |
| POST | `/campaigns/:id/pause`    | Stop picking up its sends |
| POST | `/campaigns/:id/resume`   | Resume a paused campaign |
| POST | `/campaigns/:id/cancel`   | Cancel campaign + drop un-sent rows |

### Deploy the sending engine

1. **DB:** run [`db/04_sending_engine.sql`](db/04_sending_engine.sql) in Supabase.
2. **Deploy the function** (no JWT — it's authed by a shared secret):
   ```bash
   supabase functions deploy send-tick --no-verify-jwt
   ```
3. **Set its secrets** (reuse the *same* `TOKEN_ENCRYPTION_KEY` as the backend so
   it can decrypt refresh tokens):
   ```bash
   supabase secrets set \
     GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
     TOKEN_ENCRYPTION_KEY=... SEND_TICK_SECRET=... \
     SEND_MAX_PER_PASS=200 SEND_MAX_PER_USER_PER_PASS=5 \
     SEND_INTRA_PASS_DELAY_MS=8000 SEND_DEFAULT_DAILY_LIMIT=400
   ```
   (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)
4. **Schedule the tick:** edit [`db/05_cron_setup.sql`](db/05_cron_setup.sql),
   replace `<PROJECT_REF>` and `<SEND_TICK_SECRET>`, and run it in Supabase.

Test a single pass manually:
```bash
curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/send-tick \
  -H "x-tick-secret: <SEND_TICK_SECRET>"
# → { "ok": true, "claimed": N, "sent": ..., "failed": ... }
```

### Data model

- **campaign_sends** — the outbox: one row per recipient with its own
  `scheduled_at`, `status` (`scheduled`/`sending`/`sent`/`failed`/`canceled`),
  `attempts`, `locked_at`, `gmail_message_id`, `error`, and a snapshot of the
  recipient's personalization fields.
- **users.daily_send_limit** — per-account/day cap used at schedule time and as a
  runtime safety net.

### Throttling knobs (Edge Function secrets)

| Var | Default | Meaning |
|-----|---------|---------|
| `SEND_MAX_PER_PASS` | 200 | Max sends claimed in one tick (all users) |
| `SEND_MAX_PER_USER_PER_PASS` | 5 | Anti-burst cap per account per tick |
| `SEND_INTRA_PASS_DELAY_MS` | 8000 | Gap between one account's sends in a pass |
| `SEND_DEFAULT_DAILY_LIMIT` | 400 | Fallback per-account/day cap |
| `SEND_MAX_ATTEMPTS` | 5 | Retries before a transient failure is marked failed |
