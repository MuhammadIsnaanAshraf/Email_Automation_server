-- ─────────────────────────────────────────────────────────────
-- Migration: 20240106000000_add_recipient_cc_bcc.sql
-- FlowState — CC / BCC support
--
-- Recipients can now carry per-row CC and BCC addresses (extracted from the
-- uploaded list, alongside email/name/company). These get snapshotted onto
-- campaign_sends at schedule time and attached as Cc:/Bcc: headers on the SAME
-- Gmail send (one API call per row — CC/BCC never create extra send rows).
--
-- Each column holds a comma-separated address list (a cell may name several
-- copy recipients). Nullable — most rows won't have them.
-- ─────────────────────────────────────────────────────────────

alter table public.recipients
  add column if not exists cc  text,
  add column if not exists bcc text;

alter table public.campaign_sends
  add column if not exists cc  text,
  add column if not exists bcc text;
