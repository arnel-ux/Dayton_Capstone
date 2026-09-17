-- Sets each office's login account (used on the main /login page): email_address = acronym@cspc.edu.ph,
-- password = "12345" (bcrypt hash below, cost factor 10 — matches the app's
-- bcryptjs.hash(password, 10) in server.js's /offices/add and /offices/edit).
-- Safe to run on both the local dev database and the Clever Cloud production
-- database — matched by office `id`, not by name, so it only touches existing rows.
--
-- IMPORTANT: change these passwords to something office-specific once each
-- office actually starts using their login — "12345" is a placeholder only.

UPDATE offices SET email_address = 'sta@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 1;  -- Student Testing and Admission
UPDATE offices SET email_address = 'guidance@cspc.edu.ph',   password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 2;  -- Guidance and Counseling
UPDATE offices SET email_address = 'srro@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 3;  -- Student Registration and Records Office
UPDATE offices SET email_address = 'hsu@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 4;  -- Health Services Unit
UPDATE offices SET email_address = 'cashunit@cspc.edu.ph',   password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 5;  -- Cash Unit
UPDATE offices SET email_address = 'budgetunit@cspc.edu.ph', password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 6;  -- Budget Unit
UPDATE offices SET email_address = 'accunit@cspc.edu.ph',    password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 7;  -- Accounting Unit
UPDATE offices SET email_address = 'rfoiu@cspc.edu.ph',      password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 8;  -- RFOIU
UPDATE offices SET email_address = 'hrmdo@cspc.edu.ph',      password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 9;  -- Human Resource Management and Development Office
UPDATE offices SET email_address = 'cea@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 10; -- CEA
UPDATE offices SET email_address = 'cas@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 11; -- CAS
UPDATE offices SET email_address = 'ctde@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 12; -- CTDE
UPDATE offices SET email_address = 'ccs@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 13; -- CCS
UPDATE offices SET email_address = 'chs@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 14; -- CHS
UPDATE offices SET email_address = 'cthbm@cspc.edu.ph',      password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 15; -- CTHBM
UPDATE offices SET email_address = 'gs@cspc.edu.ph',         password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 16; -- GRADUATE SCHOOL
UPDATE offices SET email_address = 'buhi@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 17; -- BUHI CAMPUS
UPDATE offices SET email_address = 'sas@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 18; -- Student Affairs and Services
UPDATE offices SET email_address = 'ictu@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 19; -- Information and Communications Technology Unit
UPDATE offices SET email_address = 'spmu@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 21; -- Supply and Property Management Unit
UPDATE offices SET email_address = 'gsu@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 22; -- General Services Unit
UPDATE offices SET email_address = 'lrdu@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 23; -- Learning Resources Development Unit
UPDATE offices SET email_address = 'op@cspc.edu.ph',         password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 24; -- Office of the President
UPDATE offices SET email_address = 'vpaa@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 25; -- VPAA
UPDATE offices SET email_address = 'vpaf@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 26; -- VPAF
UPDATE offices SET email_address = 'vpric@cspc.edu.ph',      password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 27; -- VPRIC
UPDATE offices SET email_address = 'access@cspc.edu.ph',     password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 29; -- ACCESS
UPDATE offices SET email_address = 'cgad@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 30; -- CGAD
UPDATE offices SET email_address = 'ecso@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 31; -- Extension and Community Services Office
UPDATE offices SET email_address = 'chre@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 32; -- CHRE
UPDATE offices SET email_address = 'cirl@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 33; -- Center for International Relations and Linkages
UPDATE offices SET email_address = 'cqa@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 34; -- Center for Quality Assurance
UPDATE offices SET email_address = 'rdso@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 35; -- Research and Development Services Office
UPDATE offices SET email_address = 'crca@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 36; -- Center for Rinconada Culture, and the Arts
UPDATE offices SET email_address = 'iaaubc@cspc.edu.ph',     password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 37; -- Information and Alumni Affairs Unit & Broadcast Center
UPDATE offices SET email_address = 'ipdu@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 38; -- Institutional Planning and Development Unit
UPDATE offices SET email_address = 'iau@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 39; -- Internal Audit Unit
UPDATE offices SET email_address = 'nstp@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 40; -- NSTP
UPDATE offices SET email_address = 'procurement@cspc.edu.ph',password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 41; -- Procurement Unit
UPDATE offices SET email_address = 'paxs@cspc.edu.ph',       password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 42; -- PAxS
UPDATE offices SET email_address = 'pmu@cspc.edu.ph',        password = '$2b$10$Vcpdn9bA8ebK7DbDxenFJ.tbW00p7w9SDRP8JZygBmfL3JPhe20RK' WHERE id = 43; -- Project Management Unit
