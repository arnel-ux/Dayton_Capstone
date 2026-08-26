SET FOREIGN_KEY_CHECKS = 0;
CREATE DATABASE IF NOT EXISTS `cqa_db`;
USE `cqa_db`;

SET FOREIGN_KEY_CHECKS = 1;

-- ==========================================
-- 1. ADMINS & ADMIN LOGS TABLES
-- ==========================================

CREATE TABLE `admins` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(100) NOT NULL UNIQUE,
  `password` VARCHAR(255) NOT NULL,
  `fullname` VARCHAR(255) NOT NULL,
  `gender` VARCHAR(50) DEFAULT 'Male',
  `role` VARCHAR(50) DEFAULT 'Super Admin',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Initial Seed Data for Admins
INSERT INTO `admins` (`id`, `username`, `password`, `fullname`, `gender`, `role`) VALUES
(1, 'admin1', 'francis123', 'Francis James Obis', 'Male', 'Super Admin'),
(2, 'admin2', 'arnel123', 'Arnel Marquina', 'Male', 'Admin');

DROP TABLE IF EXISTS `admin_logs`;
CREATE TABLE `admin_logs` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `admin_id` INT(11) NULL,
  `username` VARCHAR(255) NOT NULL,
  `login_time` DATETIME NOT NULL,
  `logout_time` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`id`),
  FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `admin_logs` (`id`, `admin_id`, `username`, `login_time`, `logout_time`, `created_at`) VALUES
(1, 1, 'admin1', '2026-08-23 23:39:24', '2026-08-23 23:39:42', '2026-08-23 15:39:24'),
(2, 2, 'admin2', '2026-08-24 20:55:51', '2026-08-24 20:59:10', '2026-08-24 12:55:51');

-- ==========================================
-- 2. CLIENT ACCOUNTS & TYPES TABLES
-- ==========================================

CREATE TABLE `client_accounts` (
  `email` VARCHAR(255) NOT NULL,
  `respondent_name` VARCHAR(255) DEFAULT NULL,
  `region` VARCHAR(100) DEFAULT NULL,
  `age` VARCHAR(50) DEFAULT NULL,
  `gender` VARCHAR(50) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP() ON UPDATE CURRENT_TIMESTAMP(),
  `password` VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `client_accounts` (`email`, `respondent_name`, `region`, `age`, `gender`, `created_at`, `updated_at`, `password`) VALUES
('arllagas@my.cspc.edu.ph', 'Anonymous', NULL, NULL, NULL, '2026-08-19 02:25:42', '2026-08-21 02:38:57', '$2b$10$wmeBWZ6S/uPIs4NT.nhhgeea0qjVSg0JpBY2zR2SHg5eMVq94U6ve'),
('frobis@my.cspc.edu.ph', 'Anonymous', 'Region V - Bicol Region', '19-24', 'Male', '2026-08-18 14:35:07', '2026-08-21 09:00:20', '$2b$10$M1Uh5Gt9Rk.RU/dZELkkYOvG3YsglZbSsjDd6W65U8c8iuml8QLga'),
('jamesobisfrancis072003@gmail.com', 'james obis', NULL, NULL, NULL, '2026-08-20 13:24:14', '2026-08-20 13:31:47', '$2b$10$kvpNwrJNDbSxkzVfQL/U6OPZw5Dv68KbWCrvZxEv5.XMEsjxSRg/i'),
('kechavez@my.cspc.edu.ph', 'Anonymous', NULL, NULL, NULL, '2026-08-21 01:44:43', '2026-08-21 01:47:25', '$2b$10$V3MGXz5L5QdmBJuwQM1UN.F3rVAj947rb.aKT2II3wi7x6GJa2ZYC');

CREATE TABLE `client_types` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `type_name` VARCHAR(100) NOT NULL UNIQUE,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `client_types` (`id`, `type_name`, `created_at`) VALUES
(1, 'Citizen', '2026-08-21 09:21:58'),
(2, 'Business', '2026-08-21 09:21:58'),
(3, 'Government', '2026-08-21 09:21:58'),
(4, 'Student', '2026-08-21 09:21:58');

-- ==========================================
-- 3. CLUSTERS & OFFICES TABLES
-- ==========================================

CREATE TABLE `clusters` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `cluster_name` VARCHAR(150) NOT NULL UNIQUE,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  `is_archived` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `clusters` (`id`, `cluster_name`, `created_at`, `is_archived`) VALUES
(1, 'Office of the President Cluster', '2026-07-13 15:02:10', 0),
(2, 'Administrative and Finance Cluster', '2026-07-13 15:02:10', 0),
(3, 'Academic Cluster', '2026-07-13 15:02:10', 0),
(4, 'Research, Innovation and Collaboration Cluster', '2026-07-13 15:02:10', 0);

CREATE TABLE `offices` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `cluster_name` VARCHAR(150) NOT NULL,
  `office_name` VARCHAR(255) NOT NULL,
  `head_director` VARCHAR(255) DEFAULT 'Not Assigned',
  `email_address` VARCHAR(255) NOT NULL,
  `is_archived` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `offices` (`id`, `cluster_name`, `office_name`, `head_director`, `email_address`, `is_archived`) VALUES
(1, 'Academic Cluster', 'Student Testing and Admission', 'Not Assigned', 'default@cspc.edu.ph', 0),
(2, 'Academic Cluster', 'Guidance and Counseling', 'Not Assigned', 'default@cspc.edu.ph', 0),
(3, 'Academic Cluster', 'Student Registration and Records Office', 'Not Assigned', 'default@cspc.edu.ph', 0),
(4, 'Administrative and Finance Cluster', 'Health Services Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(5, 'Administrative and Finance Cluster', 'Cash Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(6, 'Administrative and Finance Cluster', 'Budget Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(7, 'Administrative and Finance Cluster', 'Accounting Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(8, 'Administrative and Finance Cluster', 'RFOIU', 'Not Assigned', 'default@cspc.edu.ph', 0),
(9, 'Administrative and Finance Cluster', 'Human Resource Management and Development Office', 'Not Assigned', 'default@cspc.edu.ph', 0),
(10, 'Academic Cluster', 'CEA', 'Not Assigned', 'default@cspc.edu.ph', 0),
(11, 'Academic Cluster', 'CAS', 'Not Assigned', 'default@cspc.edu.ph', 0),
(12, 'Academic Cluster', 'CTDE', 'Not Assigned', 'default@cspc.edu.ph', 0),
(13, 'Academic Cluster', 'CCS', 'Not Assigned', 'default@cspc.edu.ph', 0),
(14, 'Academic Cluster', 'CHS', 'Not Assigned', 'default@cspc.edu.ph', 0),
(15, 'Academic Cluster', 'CTHBM', 'Not Assigned', 'default@cspc.edu.ph', 0),
(16, 'Academic Cluster', 'GRADUATE SCHOOL', 'Not Assigned', 'default@cspc.edu.ph', 0),
(17, 'Academic Cluster', 'BUHI CAMPUS', 'Not Assigned', 'default@cspc.edu.ph', 0),
(18, 'Academic Cluster', 'Student Affairs and Services', 'Not Assigned', 'default@cspc.edu.ph', 0),
(19, 'Administrative and Finance Cluster', 'Information and Communications Technology Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(21, 'Administrative and Finance Cluster', 'Supply and Property Management Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(22, 'Administrative and Finance Cluster', 'General Services Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(23, 'Academic Cluster', 'Learning Resources Development Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(24, 'Office of the President Cluster', 'Office of the President', 'Not Assigned', 'default@cspc.edu.ph', 0),
(25, 'Office of the President Cluster', 'VPAA', 'Not Assigned', 'default@cspc.edu.ph', 0),
(26, 'Office of the President Cluster', 'VPAF', 'Not Assigned', 'default@cspc.edu.ph', 0),
(27, 'Office of the President Cluster', 'VPRIC', 'Not Assigned', 'default@cspc.edu.ph', 0),
(29, 'Academic Cluster', 'Academic Center for Continuing Enhancement Services for Students (ACCESS)', 'Not Assigned', 'default@cspc.edu.ph', 0),
(30, 'Academic Cluster', 'Center for Gender and Development (CGAD)', 'Not Assigned', 'default@cspc.edu.ph', 0),
(31, 'Research, Innovation and Collaboration Cluster', 'Extension and Community Services Office', 'Not Assigned', 'default@cspc.edu.ph', 0),
(32, 'Academic Cluster', 'Center for Human Rights Education (CHRE)', 'Not Assigned', 'default@cspc.edu.ph', 0),
(33, 'Office of the President Cluster', 'Center for International Relations and Linkages', 'Not Assigned', 'default@cspc.edu.ph', 0),
(34, 'Academic Cluster', 'Center for Quality Assurance', 'Not Assigned', 'default@cspc.edu.ph', 0),
(35, 'Research, Innovation and Collaboration Cluster', 'Research and Development Services Office', 'Not Assigned', 'default@cspc.edu.ph', 0),
(36, 'Research, Innovation and Collaboration Cluster', 'Center for Rinconada Culture, and the Arts', 'Not Assigned', 'default@cspc.edu.ph', 0),
(37, 'Academic Cluster', 'Information and Alumni Affairs Unit & Broadcast Center', 'Not Assigned', 'default@cspc.edu.ph', 0),
(38, 'Office of the President Cluster', 'Institutional Planning and Development Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(39, 'Office of the President Cluster', 'Internal Audit Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(40, 'Academic Cluster', 'National Service Training Program (NSTP)', 'Not Assigned', 'default@cspc.edu.ph', 0),
(41, 'Administrative and Finance Cluster', 'Procurement Unit', 'Not Assigned', 'default@cspc.edu.ph', 0),
(42, 'Research, Innovation and Collaboration Cluster', 'PAxS', 'Not Assigned', 'default@cspc.edu.ph', 0),
(43, 'Administrative and Finance Cluster', 'Project Management Unit', 'Not Assigned', 'default@cspc.edu.ph', 0);

-- ==========================================
-- 4. SERVICES TABLE
-- ==========================================

CREATE TABLE `services` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `office_id` INT(11) NOT NULL,
  `service_name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `services` (`id`, `office_id`, `service_name`) VALUES
(1, 1, 'Applying for College Entrance Examination (Freshmen, Transferees)'),
(2, 1, 'Applying for Entrance Examination (Graduate School Students)'),
(3, 1, 'Applying for Shifting / Re-Admission'),
(4, 1, 'Administering of Personality/ IQ Tests'),
(5, 2, 'Availing of Counseling Services'),
(6, 2, 'Referring a Student for Counseling'),
(7, 3, 'Applying for Enrolment (Freshmen)'),
(8, 3, 'Applying for Enrolment (Transferees)'),
(9, 3, 'Applying for Enrolment (Current and Returning Students)'),
(10, 3, 'Applying for Authentication of Academic Records'),
(11, 3, 'Applying for Certification, Authentication and Verification (CAV) of Academic Records'),
(12, 3, 'Applying for the Issuance of Credentials (Official Transcript of Records, Certifications)'),
(13, 3, 'Applying for Re-Issuance of Diploma'),
(14, 3, 'Applying for Graduation'),
(15, 3, 'Applying for Issuance of Honorable Dismissal/Certificate of Eligibility to Transfer'),
(16, 3, 'Applying for Cross-Enrolment'),
(17, 3, 'Applying for Adding/Dropping of Subjects'),
(18, 3, 'Request for the Change / Correction of Grades'),
(19, 3, 'Request for Authority to Access SIAS Account for Grade Encoding'),
(20, 4, 'Availing of Oral Examination and Certification'),
(21, 4, 'Dental Treatment and Certification'),
(22, 4, 'Availing of Medical Consultation and Treatment'),
(23, 4, 'Securing Medical Certificate'),
(24, 5, 'Paying of Required Fees'),
(25, 5, 'Accepting Remittance of Scholarship Grants/Aids and Financial Assistance to Students'),
(26, 5, 'Requesting for Reimbursement of Petty Cash Expenses'),
(27, 5, 'Requesting for Liquidation of Petty Cash Expenses'),
(28, 6, 'Requesting for an Obligation of Claim for Payment'),
(29, 7, 'Requesting for Clearance'),
(30, 7, 'Requesting Statement of Student Accounts Balances'),
(31, 8, 'Securing Certified Copies of Documents'),
(32, 9, 'Applying for Leave of Absence with or without pay'),
(33, 9, 'Securing Service Records, Certificate of Employment and Other Personnel Record'),
(34, 10, 'Securing Certificate of Good Moral Character'),
(35, 11, 'Securing Certificate of Good Moral Character'),
(36, 12, 'Securing Certificate of Good Moral Character'),
(37, 13, 'Securing Certificate of Good Moral Character'),
(38, 14, 'Securing Certificate of Good Moral Character'),
(39, 15, 'Securing Certificate of Good Moral Character'),
(40, 16, 'Securing Certificate of Good Moral Character'),
(41, 17, 'Securing Certificate of Good Moral Character'),
(42, 18, 'Applying for Student Organizations Accreditation'),
(43, 18, 'Complaining or Seeking Redress of Grievances'),
(44, 18, 'Requesting Permit to Conduct Campus Activity/Educational Tour and Other Related Student Activity'),
(45, 18, 'Applying for Scholarship'),
(46, 19, 'Applying for New Identification Card (New/Renewal)'),
(47, 19, 'Issuance of Institutional E-mail Address'),
(48, 19, 'Printing of Employees\' Identification Card'),
(51, 21, 'Applying/Renewal of Application for Bed Space at the College Dormitory'),
(52, 21, 'Borrowing Equipment and Other Facilities'),
(53, 21, 'Renting College Equipment and Facilities'),
(54, 21, 'Requesting Issuance/Release of Supplies and Materials, Equipment and Accountable Forms'),
(55, 22, 'Requesting for Transportation Services'),
(56, 23, 'Lending Books'),
(57, 23, 'Returning Books'),
(58, 23, 'Providing research assistance to external clients'),
(59, 24, 'Travel Order Issuance to Students and Employees outside the Bicol Region'),
(60, 25, 'Travel Order Issuance to Students, Teaching Staff, and Employees within the Bicol Region'),
(61, 26, 'Travel Order Issuance to Employees within the Bicol Region'),
(62, 27, 'Travel Order Issuance to Employees in REPED within the Bicol Region'),
(64, 29, 'GENERAL SERVICES OFFERED'),
(65, 30, 'GENERAL SERVICES OFFERED'),
(66, 31, 'GENERAL SERVICES OFFERED'),
(67, 32, 'GENERAL SERVICES OFFERED'),
(68, 33, 'GENERAL SERVICES OFFERED'),
(69, 34, 'GENERAL SERVICES OFFERED'),
(70, 35, 'GENERAL SERVICES OFFERED'),
(71, 36, 'GENERAL SERVICES OFFERED'),
(72, 37, 'GENERAL SERVICES OFFERED'),
(73, 38, 'GENERAL SERVICES OFFERED'),
(74, 39, 'GENERAL SERVICES OFFERED'),
(75, 40, 'GENERAL SERVICES OFFERED'),
(76, 41, 'GENERAL SERVICES OFFERED'),
(77, 42, 'GENERAL SERVICES OFFERED'),
(78, 43, 'GENERAL SERVICES OFFERED');

-- ==========================================
-- 5. SURVEY RESPONSES & PROFILES TABLES
-- ==========================================

CREATE TABLE `survey_responses` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `office_id` INT(11) NOT NULL,
  `respondent_name` VARCHAR(255) DEFAULT 'Anonymous',
  `topic` VARCHAR(100) DEFAULT 'General',
  `region` VARCHAR(100) DEFAULT NULL,
  `cc1` VARCHAR(50) DEFAULT NULL,
  `cc2` VARCHAR(50) DEFAULT NULL,
  `cc3` VARCHAR(50) DEFAULT NULL,
  `sqd0` INT(11) DEFAULT NULL,
  `sqd1` INT(11) DEFAULT NULL,
  `sqd2` INT(11) DEFAULT NULL,
  `sqd3` INT(11) DEFAULT NULL,
  `sqd4` INT(11) DEFAULT NULL,
  `sqd5` INT(11) DEFAULT NULL,
  `sqd6` INT(11) DEFAULT NULL,
  `sqd7` INT(11) DEFAULT NULL,
  `sqd8` INT(11) DEFAULT NULL,
  `comments` TEXT DEFAULT NULL,
  `period_year_quarter` VARCHAR(20) DEFAULT '2026-Q1',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  `sentiment` VARCHAR(50) DEFAULT 'Neutral',
  `google_email` VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_office_google_email` (`office_id`,`google_email`),
  FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `survey_responses` (`id`, `office_id`, `respondent_name`, `topic`, `region`, `cc1`, `cc2`, `cc3`, `sqd0`, `sqd1`, `sqd2`, `sqd3`, `sqd4`, `sqd5`, `sqd6`, `sqd7`, `sqd8`, `comments`, `period_year_quarter`, `created_at`, `sentiment`, `google_email`) VALUES
(1, 16, 'Anonymous', 'General', 'Region V - Bicol Region', 'I know what a CC is but I did not see this office\'', 'Easy to see', 'Helped very much', 4, 4, 4, 4, 4, 4, 4, 4, 4, 'N/A', 'Jul - Dec 2026', '2026-08-21 02:38:57', 'Neutral', 'arllagas@my.cspc.edu.ph'),
(2, 5, 'Anonymous', 'Queueing and Waiting Time', 'Region VI - Western Visayas', 'I learned of the CC only when I saw this office\'s ', 'Difficult to see', 'Did not help', 2, 3, 2, 2, 2, 3, 2, 2, 3, 'walang barya', 'Jul - Dec 2026', '2026-08-21 05:25:49', 'Negative', 'kechavez@my.cspc.edu.ph'),
(3, 13, 'Anonymous', 'Ease of Use', 'Region V - Bicol Region', 'I know what a CC is and I saw this office\'s CC.', 'Easy to see', 'Helped very much', 5, 5, 5, 5, 5, 5, 5, 5, 5, 'good transac', 'Jul - Dec 2026', '2026-08-21 05:38:12', 'Positive', 'kechavez@my.cspc.edu.ph'),
(4, 7, 'Anonymous', 'Queueing and Waiting Time', 'Region XI - Davao Region', 'I know what a CC is and I saw this office\'s CC.', 'Easy to see', 'Helped very much', 2, 3, 3, 2, 3, 2, 3, 2, 3, 'N/A', 'Jul - Dec 2026', '2026-08-21 05:42:34', 'Neutral', 'kechavez@my.cspc.edu.ph'),
(5, 15, 'Anonymous', 'General', 'Region IX - Zamboanga Peninsula', 'I know what a CC is and I saw this office\'s CC.', 'Difficult to see', 'Helped very much', 5, 5, 5, 5, 5, 5, 5, 5, 5, 'N/A', 'Jul - Dec 2026', '2026-08-21 05:46:04', 'Neutral', 'kechavez@my.cspc.edu.ph'),
(6, 5, 'james obis', 'Queueing and Waiting Time', 'Region V - Bicol Region', 'I know what a CC is and I saw this office\'s CC.', 'Easy to see', 'Helped very much', 5, 5, 5, 5, 5, 5, 5, 5, 5, 'n/a', 'Jul - Dec 2026', '2026-08-21 06:22:16', 'Neutral', 'frobis@my.cspc.edu.ph'),
(7, 13, 'Anonymous', 'General', 'Region V - Bicol Region', 'I do not know what a CC is and I did not see one i', 'Somewhat easy to see', 'Somewhat helped', 5, 5, 5, 5, 5, 5, 5, 5, 5, 'N/A', 'July to Dec 2026', '2026-08-21 09:00:20', 'Neutral', 'frobis@my.cspc.edu.ph');

CREATE TABLE `client_profiles` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `survey_response_id` INT(11) NOT NULL,
  `respondent_name` VARCHAR(255) DEFAULT 'Anonymous',
  `client_type` VARCHAR(100) DEFAULT 'Citizen',
  `age` VARCHAR(50) DEFAULT NULL,
  `gender` VARCHAR(50) DEFAULT NULL,
  `region` VARCHAR(100) DEFAULT NULL,
  `email` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`id`),
  FOREIGN KEY (`survey_response_id`) REFERENCES `survey_responses` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `client_profiles` (`id`, `survey_response_id`, `respondent_name`, `client_type`, `age`, `gender`, `region`, `email`, `created_at`) VALUES
(1, 1, 'Anonymous', 'Citizen', '19-24', 'Male', 'Region V - Bicol Region', 'arllagas@my.cspc.edu.ph', '2026-08-21 02:38:57'),
(2, 2, 'Anonymous', 'Citizen', '19-24', 'Male', 'Region VI - Western Visayas', 'kechavez@my.cspc.edu.ph', '2026-08-21 05:25:49'),
(3, 3, 'Anonymous', 'Business', '19-24', 'Male', 'Region V - Bicol Region', 'kechavez@my.cspc.edu.ph', '2026-08-21 05:38:12'),
(4, 4, 'Anonymous', 'Government', '19-24', 'Male', 'Region XI - Davao Region', 'kechavez@my.cspc.edu.ph', '2026-08-21 05:42:34'),
(5, 5, 'Anonymous', 'Business', '19-24', 'Male', 'Region IX - Zamboanga Peninsula', 'kechavez@my.cspc.edu.ph', '2026-08-21 05:46:04'),
(6, 6, 'james obis', 'Citizen', '19-24', 'Male', 'Region V - Bicol Region', 'frobis@my.cspc.edu.ph', '2026-08-21 06:22:16'),
(7, 7, 'Anonymous', 'Citizen', '19-24', 'Male', 'Region V - Bicol Region', 'frobis@my.cspc.edu.ph', '2026-08-21 09:00:20');

-- ==========================================
-- 6. SURVEY SETTINGS
-- ==========================================

CREATE TABLE `survey_settings` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `category` VARCHAR(50) NOT NULL,
  `content` TEXT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  `is_archived` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `survey_settings` (`id`, `category`, `content`, `created_at`, `is_archived`) VALUES
(1, 'sqd', 'I am satisfied with the service that I availed.', '2026-07-13 13:03:02', 0),
(2, 'sqd', 'I spent a reasonable amount of time for my transaction.', '2026-07-13 13:03:02', 0),
(3, 'sqd', 'The office followed the transaction\'s requirements and steps based on the information provided.', '2026-07-13 13:03:02', 0),
(4, 'sqd', 'The steps (including payment) I needed to do for my transaction were easy and simple.', '2026-07-13 13:03:02', 0),
(5, 'sqd', 'I easily found information about my transaction from the office or its website.', '2026-07-13 13:03:02', 0),
(6, 'sqd', 'I paid a reasonable amount of fees for my transaction.', '2026-07-13 13:03:02', 0),
(7, 'sqd', 'I feel the office was fair to everyone, or \"walang palakasan\", during my transaction.', '2026-07-13 13:03:02', 0),
(8, 'sqd', 'I was treated courteously by the staff, and (if asked for help) the staff was helpful.', '2026-07-13 13:03:02', 0),
(9, 'sqd', 'I got what I needed from the government office, or (if denied) denial of request was sufficiently explained to me.', '2026-07-13 13:03:02', 0),
(10, 'cc', 'Which of the following best describes your awareness of a CC?', '2026-07-13 13:03:02', 0),
(11, 'cc', 'If aware of CC (answered 1-3 in CC1), would you say that the CC of this office was...?', '2026-07-13 13:03:02', 0),
(12, 'cc', 'If aware of CC (answered 1-3 in CC1), how much did the CC help you in your transaction?', '2026-07-13 13:03:02', 0);