-- =====================================================================
-- Office full names for printed reports
-- =====================================================================
-- Thirteen offices are stored in `offices.office_name` under the acronym
-- staff use day to day (CCS, VPAA, RFOIU, ...). That short form is fine in
-- dropdowns, charts and the offices table, but CSPC's printed CSM reports
-- must carry the office's complete name.
--
-- `full_name` holds that complete name. It is NULL for every office whose
-- `office_name` is already spelled out; reports fall back to `office_name`
-- whenever it is NULL or blank, so nothing has to be filled in for the
-- other offices.
--
-- The expansions below come from this project's own public office
-- directory (admin-portal/views/index.ejs, "OUR SERVICES DATA"), not from
-- guesswork.
--
-- Run:
--   mysql -u root cqa_db < admin-portal/migrations/add_office_full_name.sql
--
-- server.js also adds the column on boot (ALTER TABLE ... ADD COLUMN), so
-- this file only needs running to apply the backfill below.
-- =====================================================================

ALTER TABLE offices ADD COLUMN full_name VARCHAR(255) NULL;

UPDATE offices SET full_name = 'Records and Freedom of Information Unit'            WHERE id = 8  AND office_name = 'RFOIU';
UPDATE offices SET full_name = 'College of Engineering and Architecture'            WHERE id = 10 AND office_name = 'CEA';
UPDATE offices SET full_name = 'College of Arts and Sciences'                       WHERE id = 11 AND office_name = 'CAS';
UPDATE offices SET full_name = 'College of Technological and Development Education' WHERE id = 12 AND office_name = 'CTDE';
UPDATE offices SET full_name = 'College of Computer Studies'                        WHERE id = 13 AND office_name = 'CCS';
UPDATE offices SET full_name = 'College of Health Sciences'                         WHERE id = 14 AND office_name = 'CHS';
UPDATE offices SET full_name = 'College of Tourism, Hospitality, and Business Management' WHERE id = 15 AND office_name = 'CTHBM';
UPDATE offices SET full_name = 'Graduate School'                                    WHERE id = 16 AND office_name = 'GRADUATE SCHOOL';
UPDATE offices SET full_name = 'Buhi Campus'                                        WHERE id = 17 AND office_name = 'BUHI CAMPUS';
UPDATE offices SET full_name = 'Vice President for Academic Affairs Office'         WHERE id = 25 AND office_name = 'VPAA';
UPDATE offices SET full_name = 'Vice President for Administration and Finance Office' WHERE id = 26 AND office_name = 'VPAF';
UPDATE offices SET full_name = 'Vice President for Research, Innovation, and Collaboration Office' WHERE id = 27 AND office_name = 'VPRIC';
UPDATE offices SET full_name = 'Public Affairs and Special Concerns Office'          WHERE id = 42 AND office_name = 'PAxS';
