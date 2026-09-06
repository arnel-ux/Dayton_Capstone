-- ============================================================================
-- Online-vs-Offline canonical-precedence fix for survey_responses /
-- pending_survey_submissions.
--
-- Root cause this addresses: the same authenticated Client account could
-- successfully submit the same logical survey (same office + account +
-- service) both online and offline, because the two channels used separate
-- idempotency keys (client_submission_id vs offline_submission_id) and the
-- one shared eligibility gate (checkResubmissionEligibility) was a plain
-- non-atomic SELECT-then-INSERT with no backing unique index once
-- unique_office_google_email was deliberately dropped for per-service
-- cadence support.
--
-- `submission_source` records which channel actually created a row
-- (server-derived at insert time — see server.js's submitCanonicalSurvey /
-- queuePendingSurveyWithPrecedence — never trusted from client JSON).
-- `canonical_status` + `superseded_by_id` let an Online submission
-- supersede an earlier-canonical Offline row for the SAME office+account+
-- service (Online always dominates, regardless of arrival order) while
-- keeping the losing row for audit instead of deleting it. Every dashboard/
-- report/records/history query that counts survey_responses filters to
-- canonical_status = 'canonical' (see server.js's Part-40 query audit).
--
-- Existing rows predate this distinction entirely — their real origin
-- (online vs offline) is genuinely unknown, so submission_source defaults
-- to 'legacy_unknown' for them, NOT 'online'. (An earlier draft of this
-- migration defaulted historical rows to 'online', which would have made
-- resolveSubmissionPrecedence treat every pre-fix row as definitively
-- online — silently preventing a real historical Offline row from ever
-- being superseded by a genuinely later Online submission for the same
-- still-in-cooldown opportunity. server.js's resolveSubmissionPrecedence
-- treats 'legacy_unknown' the same as 'offline_sync' — i.e. "not known to
-- be online, so a real Online submission may still supersede it" — which
-- is the safe outcome regardless of what a given historical row's real
-- origin actually was.) canonical_status defaults to 'canonical' for
-- historical rows, which IS correct/safe: nothing has determined any
-- pre-existing row to be superseded, so every one of them keeps counting
-- in dashboards/reports/records/history exactly as before, until/unless a
-- NEW submission going forward legitimately supersedes it through the
-- normal precedence flow. This migration itself never marks any existing
-- row superseded, and never rewrites any existing submission_source value.
--
-- Safe/non-destructive: nullable/defaulted columns, one new index, no data
-- migration, no rows modified. If this migration already ran once with the
-- OLDER 'online' default (see above), re-running it is still a no-op —
-- ADD COLUMN IF NOT EXISTS never touches a column that's already there, so
-- already-mislabeled rows are NOT automatically corrected. To find rows
-- that may be affected, run (read-only, does not modify anything):
--
--   SELECT office_id, google_email, service_availed, id, created_at, submission_source
--   FROM survey_responses
--   WHERE submission_source = 'online' AND canonical_status = 'canonical'
--   ORDER BY office_id, google_email, service_availed, created_at;
--
-- and manually review/decide on a case-by-case UPDATE — do not bulk-rewrite
-- without confirming each row's real origin.
--
-- Note: server.js already applies this automatically on startup (adds the
-- columns/index if missing). This file is provided only for manually
-- applying the same change outside of starting the server.
--
--   mysql -u root cqa_db < admin-portal/migrations/add_online_offline_precedence.sql
-- ============================================================================

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS submission_source ENUM('online','offline_sync','legacy_unknown') NOT NULL DEFAULT 'legacy_unknown';

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS canonical_status ENUM('canonical','superseded') NOT NULL DEFAULT 'canonical';

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS superseded_by_id INT NULL;

CREATE INDEX IF NOT EXISTS idx_survey_responses_logical_key
  ON survey_responses(office_id, google_email, service_availed, canonical_status);

ALTER TABLE pending_survey_submissions
  ADD COLUMN IF NOT EXISTS submission_source ENUM('online','offline_sync','legacy_unknown') NOT NULL DEFAULT 'legacy_unknown';
