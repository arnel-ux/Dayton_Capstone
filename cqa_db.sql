-- Step 1: Database Setup
CREATE DATABASE IF NOT EXISTS cqa_db;
USE cqa_db;

-- Step 2: Disable Foreign Keys & Reset Tables
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS client_profiles;
DROP TABLE IF EXISTS survey_responses;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS offices;
SET FOREIGN_KEY_CHECKS = 1;

-- Step 3: Create Tables
CREATE TABLE offices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cluster_name VARCHAR(150) NOT NULL,
    office_name VARCHAR(255) NOT NULL,
    head_director VARCHAR(255) DEFAULT 'Not Assigned',
    email_address VARCHAR(255) NOT NULL
);

CREATE TABLE survey_responses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    office_id INT NOT NULL,
    respondent_name VARCHAR(255) DEFAULT 'Anonymous',
    topic VARCHAR(100) DEFAULT 'General',
    region VARCHAR(100) NULL,
    cc1 VARCHAR(50) NULL, 
    cc2 VARCHAR(50) NULL, 
    cc3 VARCHAR(50) NULL,
    sqd0 INT NULL, sqd1 INT NULL, sqd2 INT NULL, sqd3 INT NULL, 
    sqd4 INT NULL, sqd5 INT NULL, sqd6 INT NULL, sqd7 INT NULL, sqd8 INT NULL,
    comments TEXT NULL,
    period_year_quarter VARCHAR(20) DEFAULT '2026-Q1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (office_id) REFERENCES offices(id) ON DELETE CASCADE
);

CREATE TABLE client_profiles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    survey_response_id INT NOT NULL,
    respondent_name VARCHAR(255) DEFAULT 'Anonymous',
    client_type VARCHAR(100) DEFAULT 'Citizen',
    age VARCHAR(50) NULL,
    gender VARCHAR(50) NULL,
    region VARCHAR(100) NULL,
    email VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (survey_response_id) REFERENCES survey_responses(id) ON DELETE CASCADE
);

CREATE TABLE services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    office_id INT NOT NULL,
    service_name VARCHAR(255) NOT NULL,
    FOREIGN KEY (office_id) REFERENCES offices(id) ON DELETE CASCADE
);

-- Step 4: Populate Offices Table (4 Clusters / 41 Offices)
INSERT INTO offices (id, cluster_name, office_name, head_director, email_address) VALUES
-- ACADEMIC CLUSTER (19 Offices)
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

-- ADMINISTRATIVE AND FINANCE CLUSTER (11 Offices)
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

-- OFFICE OF THE PRESIDENT CLUSTER (7 Offices)
(24, 'Office of the President Cluster', 'Office of the President', 'Not Assigned', 'default@cspc.edu.ph'),
(25, 'Office of the President Cluster', 'VPAA', 'Not Assigned', 'default@cspc.edu.ph'),
(26, 'Office of the President Cluster', 'VPAF', 'Not Assigned', 'default@cspc.edu.ph'),
(27, 'Office of the President Cluster', 'VPRIC', 'Not Assigned', 'default@cspc.edu.ph'),
(33, 'Office of the President Cluster', 'Center for International Relations and Linkages', 'Not Assigned', 'default@cspc.edu.ph'),
(38, 'Office of the President Cluster', 'Institutional Planning and Development Unit', 'Not Assigned', 'default@cspc.edu.ph'),
(39, 'Office of the President Cluster', 'Internal Audit Unit', 'Not Assigned', 'default@cspc.edu.ph'),

-- RESEARCH, INNOVATION AND COLLABORATION CLUSTER (4 Offices)
(31, 'Research, Innovation and Collaboration Cluster', 'Extension and Community Services Office', 'Not Assigned', 'default@cspc.edu.ph'),
(35, 'Research, Innovation and Collaboration Cluster', 'Research and Development Services Office', 'Not Assigned', 'default@cspc.edu.ph'),
(36, 'Research, Innovation and Collaboration Cluster', 'Center for Rinconada Culture, and the Arts', 'Not Assigned', 'default@cspc.edu.ph'),
(42, 'Research, Innovation and Collaboration Cluster', 'PAxS', 'Not Assigned', 'default@cspc.edu.ph');

-- Step 5: Populate Services Table
INSERT INTO services (office_id, service_name) VALUES
(1, 'Applying for College Entrance Examination (Freshmen, Transferees)'),
(1, 'Applying for Entrance Examination (Graduate School Students)'),
(1, 'Applying for Shifting / Re-Admission'),
(1, 'Administering of Personality/ IQ Tests'),
(2, 'Availing of Counseling Services'),
(2, 'Referring a Student for Counseling'),
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
(4, 'Availing of Oral Examination and Certification'),
(4, 'Dental Treatment and Certification'),
(4, 'Availing of Medical Consultation and Treatment'),
(4, 'Securing Medical Certificate'),
(5, 'Paying of Required Fees'),
(5, 'Accepting Remittance of Scholarship Grants/Aids and Financial Assistance to Students'),
(5, 'Requesting for Reimbursement of Petty Cash Expenses'),
(5, 'Requesting for Liquidation of Petty Cash Expenses'),
(6, 'Requesting for an Obligation of Claim for Payment'),
(7, 'Requesting for Clearance'),
(7, 'Requesting Statement of Student Accounts Balances'),
(8, 'Securing Certified Copies of Documents'),
(9, 'Applying for Leave of Absence with or without pay'),
(9, 'Securing Service Records, Certificate of Employment and Other Personnel Record'),
(10, 'Securing Certificate of Good Moral Character'),
(11, 'Securing Certificate of Good Moral Character'),
(12, 'Securing Certificate of Good Moral Character'),
(13, 'Securing Certificate of Good Moral Character'),
(14, 'Securing Certificate of Good Moral Character'),
(15, 'Securing Certificate of Good Moral Character'),
(16, 'Securing Certificate of Good Moral Character'),
(17, 'Securing Certificate of Good Moral Character'),
(18, 'Applying for Student Organizations Accreditation'),
(18, 'Complaining or Seeking Redress of Grievances'),
(18, 'Requesting Permit to Conduct Campus Activity/Educational Tour and Other Related Student Activity'),
(18, 'Applying for Scholarship'),
(19, 'Applying for New Identification Card (New/Renewal)'),
(19, 'Issuance of Institutional E-mail Address'),
(19, 'Printing of Employees'' Identification Card'),
(21, 'Applying/Renewal of Application for Bed Space at the College Dormitory'),
(21, 'Borrowing Equipment and Other Facilities'),
(21, 'Renting College Equipment and Facilities'),
(21, 'Requesting Issuance/Release of Supplies and Materials, Equipment and Accountable Forms'),
(22, 'Requesting for Transportation Services'),
(23, 'Lending Books'),
(23, 'Returning Books'),
(23, 'Providing research assistance to external clients'),
(24, 'Travel Order Issuance to Students and Employees outside the Bicol Region'),
(25, 'Travel Order Issuance to Students, Teaching Staff, and Employees within the Bicol Region'),
(26, 'Travel Order Issuance to Employees within the Bicol Region'),
(27, 'Travel Order Issuance to Employees in REPED within the Bicol Region'),
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
(43, 'GENERAL SERVICES OFFERED');