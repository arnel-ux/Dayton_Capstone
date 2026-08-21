-- ============================================================================
-- Replace the `offices` roster with the new Cluster/Office structure, and seed
-- the `services` table so the "Service Availed" dropdown on client-survey.ejs
-- can populate itself per office.
--
-- ⚠️  READ BEFORE RUNNING — THIS IS DESTRUCTIVE:
-- Your current `offices` table has a different, older set of office names/IDs
-- than the ones inserted below. Re-inserting offices with these IDs requires
-- clearing the existing offices first, and because `survey_responses` and
-- `client_profiles` reference offices with ON DELETE CASCADE, any existing
-- survey responses tied to those old offices will be deleted too.
--
-- BACK UP FIRST. From a terminal (adjust user/password/path as needed):
--   mysqldump -u root cqa_db offices survey_responses client_profiles > cqa_db_backup_before_services.sql
--
-- Then run this file, e.g.:
--   mysql -u root cqa_db < admin-portal/migrations/update_offices_and_services.sql
-- ============================================================================

START TRANSACTION;

-- Clearing `offices` cascades (ON DELETE CASCADE) into survey_responses and
-- client_profiles — that is the actual data loss this migration causes.
DELETE FROM offices;
ALTER TABLE offices AUTO_INCREMENT = 1;

INSERT INTO offices (id, cluster_name, office_name, head_director, email_address) VALUES
-- ACADEMIC CLUSTER
(1, 'Academic Cluster', 'Student Testing and Admission', 'Not Assigned', 'default@cspc.edu.ph'),
(2, 'Academic Cluster', 'Guidance and Counseling', 'Not Assigned', 'default@cspc.edu.ph'),
(3, 'Academic Cluster', 'Student Registration and Records Office', 'Not Assigned', 'default@cspc.edu.ph'),
(10, 'Academic Cluster', 'CEA', 'Not Assigned', 'default@cspc.edu.ph'),
(11, 'Academic Cluster', 'CAS', 'Not Assigned', 'default@cspc.edu.ph'),
(12, 'Academic Cluster', 'CTDE', 'Not Assigned', 'default@cspc.edu.ph'),
(13, 'Academic Cluster', 'CCS', 'Not Assigned', 'default@cspc.edu.ph'),
(14, 'Academic Cluster', 'CHS', 'Not Assigned', 'default@cspc.edu.ph'),
(15, 'Academic Cluster', 'CTHBM', 'Not Assigned', 'default@cspc.edu.ph'),
(16, 'Academic Cluster', 'GRADUATE SCHOOL', 'Not Assigned', 'default@cspc.edu.ph'),
(17, 'Academic Cluster', 'BUHI CAMPUS', 'Not Assigned', 'default@cspc.edu.ph'),
(18, 'Academic Cluster', 'Student Affairs and Services', 'Not Assigned', 'default@cspc.edu.ph'),
(23, 'Academic Cluster', 'Learning Resources Development Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(29, 'Academic Cluster', 'Academic Center for Continuing Enhancement Services for Students (ACCESS)', 'Not Assigned', 'default@cspc.edu.ph'),
(30, 'Academic Cluster', 'Center for Gender and Development (CGAD)', 'Not Assigned', 'default@cspc.edu.ph'),
(32, 'Academic Cluster', 'Center for Human Rights Education (CHRE)', 'Not Assigned', 'default@cspc.edu.ph'),
(34, 'Academic Cluster', 'Center for Quality Assurance', 'Not Assigned', 'default@cspc.edu.ph'),
(37, 'Academic Cluster', 'Information and Alumni Affairs Unit & Broadcast Center', 'Not Assigned', 'default@cspc.edu.ph'),
(40, 'Academic Cluster', 'National Service Training Program (NSTP)', 'Not Assigned', 'default@cspc.edu.ph'),

-- ADMINISTRATIVE AND FINANCE CLUSTER
(4, 'Administrative and Finance Cluster', 'Health Services Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(5, 'Administrative and Finance Cluster', 'Cash Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(6, 'Administrative and Finance Cluster', 'Budget Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(7, 'Administrative and Finance Cluster', 'Accounting Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(8, 'Administrative and Finance Cluster', 'RFOIU', 'Not Assigned', 'default@cspc.edu.ph'),
(9, 'Administrative and Finance Cluster', 'Human Resource Management and Development Office', 'Not Assigned', 'default@cspc.edu.ph'),
(19, 'Administrative and Finance Cluster', 'Information and Communications Technology Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(21, 'Administrative and Finance Cluster', 'Supply and Property Management Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(22, 'Administrative and Finance Cluster', 'General Services Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(41, 'Administrative and Finance Cluster', 'Procurement Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(43, 'Administrative and Finance Cluster', 'Project Management Unit', 'Not Assigned', 'default@cspc.edu.ph'),

-- PRESIDENT CLUSTER
(24, 'PRESIDENT CLUSTER', 'Office of the President', 'Not Assigned', 'default@cspc.edu.ph'),
(25, 'PRESIDENT CLUSTER', 'VPAA', 'Not Assigned', 'default@cspc.edu.ph'),
(26, 'PRESIDENT CLUSTER', 'VPAF', 'Not Assigned', 'default@cspc.edu.ph'),
(27, 'PRESIDENT CLUSTER', 'VPRIC', 'Not Assigned', 'default@cspc.edu.ph'),
(33, 'PRESIDENT CLUSTER', 'Center for International Relations and Linkages', 'Not Assigned', 'default@cspc.edu.ph'),
(38, 'PRESIDENT CLUSTER', 'Institutional Planning and Development Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(39, 'PRESIDENT CLUSTER', 'Internal Audit Unit', 'Not Assigned', 'default@cspc.edu.ph'),

-- RIC CLUSTER
(31, 'RIC Cluster', 'Extension and Community Services Office', 'Not Assigned', 'default@cspc.edu.ph'),
(35, 'RIC Cluster', 'Research and Development Services Office', 'Not Assigned', 'default@cspc.edu.ph'),
(36, 'RIC Cluster', 'Center for Rinconada Culture, and the Arts', 'Not Assigned', 'default@cspc.edu.ph'),
(42, 'RIC Cluster', 'PAxS', 'Not Assigned', 'default@cspc.edu.ph'),

-- NOT ASSIGNED / UNCATEGORIZED
(20, 'Not Assigned', 'Internet Center', 'Not Assigned', 'default@cspc.edu.ph'),
(28, 'Not Assigned', 'VPREPED', 'Not Assigned', 'default@cspc.edu.ph'),
(44, 'Not Assigned', 'TESDA Office', 'Not Assigned', 'default@cspc.edu.ph');

-- `services` clears itself automatically (ON DELETE CASCADE from offices),
-- but truncate explicitly too in case this migration is re-run.
DELETE FROM services;
ALTER TABLE services AUTO_INCREMENT = 1;

INSERT INTO services (office_id, service_name) VALUES
-- 1 - Student Testing and Admission
(1, 'Applying for College Entrance Examination (Freshmen, Transferees)'),
(1, 'Applying for Entrance Examination (Graduate School Students)'),
(1, 'Applying for Shifting / Re-Admission'),
(1, 'Administering of Personality/ IQ Tests'),

-- 2 - Guidance and Counseling
(2, 'Availing of Counseling Services'),
(2, 'Referring a Student for Counseling'),

-- 3 - Student Registration and Records Office
(3, 'Applying for Enrolment (Freshmen)'),
(3, 'Applying for Enrolment (Transferees)'),
(3, 'Applying for Enrolment (Current and Returning Students)'),
(3, 'Applying for Authentication of Academic Records'),
(3, 'Applying for Certification, Authentication and Verification (CAV) of Academic Records'),
(3, 'Applying for the Issuance of Credentials (Official Transcript of Records, Certifications)'),
(3, 'Applying for Re-Issuance of Diploma'),
(3, 'Applying for Graduation'),
(3, 'Applying for Issuance of Honorable Dismissal/Certificate of Eligibility to Transfer'),
(3, 'Applying for Cross-Enrolment'),
(3, 'Applying for Adding/Dropping of Subjects'),
(3, 'Request for the Change / Correction of Grades'),
(3, 'Request for Authority to Access SIAS Account for Grade Encoding'),

-- 4 - Health Services Unit
(4, 'Availing of Oral Examination and Certification'),
(4, 'Dental Treatment and Certification'),
(4, 'Availing of Medical Consultation and Treatment'),
(4, 'Securing Medical Certificate'),

-- 5 - Cash Unit
(5, 'Paying of Required Fees'),
(5, 'Accepting Remittance of Scholarship Grants/Aids and Financial Assistance to Students'),
(5, 'Requesting for Reimbursement of Petty Cash Expenses'),
(5, 'Requesting for Liquidation of Petty Cash Expenses'),

-- 6 - Budget Unit
(6, 'Requesting for an Obligation of Claim for Payment'),

-- 7 - Accounting Unit
(7, 'Requesting for Clearance'),
(7, 'Requesting Statement of Student Accounts Balances'),

-- 8 - RFOIU
(8, 'Securing Certified Copies of Documents'),

-- 9 - Human Resource Management and Development Office
(9, 'Applying for Leave of Absence with or without pay'),
(9, 'Securing Service Records, Certificate of Employment and Other Personnel Record'),

-- 10-17 - Colleges & Campuses
(10, 'Securing Certificate of Good Moral Character'),
(11, 'Securing Certificate of Good Moral Character'),
(12, 'Securing Certificate of Good Moral Character'),
(13, 'Securing Certificate of Good Moral Character'),
(14, 'Securing Certificate of Good Moral Character'),
(15, 'Securing Certificate of Good Moral Character'),
(16, 'Securing Certificate of Good Moral Character'),
(17, 'Securing Certificate of Good Moral Character'),

-- 18 - Student Affairs and Services
(18, 'Applying for Student Organizations Accreditation'),
(18, 'Complaining or Seeking Redress of Grievances'),
(18, 'Requesting Permit to Conduct Campus Activity/Educational Tour and Other Related Student Activity'),
(18, 'Applying for Scholarship'),

-- 19 - Information and Communications Technology Unit
(19, 'Applying for New Identification Card (New/Renewal)'),
(19, 'Issuance of Institutional E-mail Address'),
(19, 'Printing of Employees'' Identification Card'),

-- 20 - Internet Center
(20, 'Applying for Renewal of Internet Access Card'),
(20, 'Accessing the School''s Internet Center Services'),

-- 21 - Supply and Property Management Unit
(21, 'Applying/Renewal of Application for Bed Space at the College Dormitory'),
(21, 'Borrowing Equipment and Other Facilities'),
(21, 'Renting College Equipment and Facilities'),
(21, 'Requesting Issuance/Release of Supplies and Materials, Equipment and Accountable Forms'),

-- 22 - General Services Unit
(22, 'Requesting for Transportation Services'),

-- 23 - Learning Resources Development Unit
(23, 'Lending Books'),
(23, 'Returning Books'),
(23, 'Providing research assistance to external clients'),

-- 24-28 - Presidents / VPs
(24, 'Travel Order Issuance to Students and Employees outside the Bicol Region'),
(25, 'Travel Order Issuance to Students, Teaching Staff, and Employees within the Bicol Region'),
(26, 'Travel Order Issuance to Employees within the Bicol Region'),
(27, 'Travel Order Issuance to Employees in REPED within the Bicol Region'),
(28, 'Requesting for Travel Order'),

-- 29-44 - Centers & Units (no distinct service text yet — placeholder)
(29, 'GENERAL SERVICES OFFERED'),
(30, 'GENERAL SERVICES OFFERED'),
(31, 'GENERAL SERVICES OFFERED'),
(32, 'GENERAL SERVICES OFFERED'),
(33, 'GENERAL SERVICES OFFERED'),
(34, 'GENERAL SERVICES OFFERED'),
(35, 'GENERAL SERVICES OFFERED'),
(36, 'GENERAL SERVICES OFFERED'),
(37, 'GENERAL SERVICES OFFERED'),
(38, 'GENERAL SERVICES OFFERED'),
(39, 'GENERAL SERVICES OFFERED'),
(40, 'GENERAL SERVICES OFFERED'),
(41, 'GENERAL SERVICES OFFERED'),
(42, 'GENERAL SERVICES OFFERED'),
(43, 'GENERAL SERVICES OFFERED'),
(44, 'GENERAL SERVICES OFFERED');

COMMIT;
