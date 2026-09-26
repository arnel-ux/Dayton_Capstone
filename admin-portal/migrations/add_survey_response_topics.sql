-- ============================================================================
-- Adds survey_response_topics — part of the multi-topic tagging project
-- (2026-09-25).
--
-- A comment that clearly names multiple distinct things (e.g. "matagal ang
-- transaction pero maayos naman ang kalinisan ng opisina") is no longer
-- collapsed into a single topic — Gemini (or the offline keyword lexicon,
-- which still only ever names one) can now attach up to gemini_model.py's
-- MAX_TOPICS topics to one comment, all under the SAME overall sentiment.
--
-- survey_responses.topic stays the PRIMARY/first topic exactly as before —
-- every existing dashboard/report/notification query keeps working
-- unchanged against it — and this table holds only the EXTRA topics beyond
-- the first, so "all topics for this comment" is `topic` UNION this table's
-- rows for that survey_response_id (ordered by sort_order, which preserves
-- Gemini's own array order). A no-feedback/junk comment never gets a row
-- here — there is no analysis to name a second topic from.
--
-- Safe/non-destructive: one new table, no data migration, no existing rows
-- modified.
--
-- Note: server.js already applies this automatically on startup (creates
-- the table if missing). This file is provided only for manually applying
-- the same change outside of starting the server.
--
--   mysql -u root cqa_db < admin-portal/migrations/add_survey_response_topics.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS survey_response_topics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    survey_response_id INT NOT NULL,
    topic VARCHAR(150) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    FOREIGN KEY (survey_response_id) REFERENCES survey_responses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_survey_response_topics_response_id
  ON survey_response_topics(survey_response_id);
