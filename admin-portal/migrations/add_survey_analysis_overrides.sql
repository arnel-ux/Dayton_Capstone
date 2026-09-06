-- ============================================================================
-- Adds admin manual-correction columns for the AI's sentiment/topic/subtopic
-- read on a survey comment (Survey Result modal "Edit Analysis" feature).
--
-- Deliberately separate from the existing `topic`/`sentiment` columns, which
-- remain the raw, untouched AI output — the AI never writes to these new
-- columns, and an admin correction never overwrites `topic`/`sentiment`. This
-- preserves the distinction between what the AI originally predicted and what
-- an admin later corrected it to, without needing a disruptive schema
-- rewrite. NULL means "no admin override" — the AI value is used as-is
-- (see server.js's effective-value computation in the survey-response routes).
--
-- Safe/non-destructive: nullable columns, no FK changes, no data migration.
--
-- Note: server.js already applies this automatically on startup (adds the
-- columns if missing). This file is provided only for manually applying the
-- same change outside of starting the server.
--
--   mysql -u root cqa_db < admin-portal/migrations/add_survey_analysis_overrides.sql
-- ============================================================================

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS topic_override VARCHAR(150) NULL;

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS subtopic_override VARCHAR(100) NULL;

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS sentiment_override VARCHAR(20) NULL;
