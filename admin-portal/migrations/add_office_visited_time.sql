-- ============================================================================
-- Adds office_visited_time to client_profiles (Time of Office Visit feature).
-- Safe/non-destructive: nullable column, no data loss, no FK changes.
--
-- Note: server.js already applies this automatically on startup via
-- `ALTER TABLE client_profiles ADD COLUMN office_visited_time TIME NULL`
-- (wrapped so it no-ops if the column already exists). This file is provided
-- only for manually applying the same change outside of starting the server.
--
--   mysql -u root cqa_db < admin-portal/migrations/add_office_visited_time.sql
-- ============================================================================

ALTER TABLE client_profiles
  ADD COLUMN IF NOT EXISTS office_visited_time TIME NULL;
