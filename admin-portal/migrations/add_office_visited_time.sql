-- ============================================================================
-- Adds/widens office_visited_time on client_profiles (Date & Time of Office
-- Visit feature). Stored as DATETIME (not TIME) because the visit can be an
-- earlier day than the survey is actually submitted on -- e.g. the client
-- visited the office Aug 28 but only fills out the survey Aug 29.
-- Safe/non-destructive: nullable column, no FK changes. Widening an existing
-- TIME column to DATETIME backfills old rows onto today's date (MySQL's
-- default TIME->DATETIME cast), matching the old same-day assumption those
-- legacy rows were recorded under.
--
-- Note: server.js already applies this automatically on startup (adds the
-- column if missing, then widens it to DATETIME if it's still TIME). This
-- file is provided only for manually applying the same change outside of
-- starting the server.
--
--   mysql -u root cqa_db < admin-portal/migrations/add_office_visited_time.sql
-- ============================================================================

ALTER TABLE client_profiles
  ADD COLUMN IF NOT EXISTS office_visited_time DATETIME NULL;

ALTER TABLE client_profiles
  MODIFY COLUMN office_visited_time DATETIME NULL;
