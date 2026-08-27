-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Aug 24, 2026 at 03:21 PM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `cqa_db`
--

-- --------------------------------------------------------

--
-- Table structure for table `admin_logs`
--

CREATE TABLE `admin_logs` (
  `id` int(11) NOT NULL,
  `username` varchar(255) NOT NULL DEFAULT 'admin',
  `login_time` datetime NOT NULL,
  `logout_time` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
--
-- Table structure for table `client_accounts`
--

CREATE TABLE `client_accounts` (
  `email` varchar(255) NOT NULL,
  `respondent_name` varchar(255) DEFAULT NULL,
  `region` varchar(100) DEFAULT NULL,
  `age` varchar(50) DEFAULT NULL,
  `gender` varchar(50) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `password` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `client_accounts`
--
-- --------------------------------------------------------

--
-- Table structure for table `client_profiles`
--

CREATE TABLE `client_profiles` (
  `id` int(11) NOT NULL,
  `survey_response_id` int(11) NOT NULL,
  `respondent_name` varchar(255) DEFAULT 'Anonymous',
  `client_type` varchar(100) DEFAULT 'Citizen',
  `age` varchar(50) DEFAULT NULL,
  `gender` varchar(50) DEFAULT NULL,
  `region` varchar(100) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `client_profiles`
--
-- --------------------------------------------------------

--
-- Table structure for table `client_types`
--

CREATE TABLE `client_types` (
  `id` int(11) NOT NULL,
  `type_name` varchar(100) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `client_types`
--

INSERT INTO `client_types` (`id`, `type_name`, `created_at`) VALUES
(1, 'Citizen', '2026-08-21 09:21:58'),
(2, 'Business', '2026-08-21 09:21:58'),
(3, 'Government', '2026-08-21 09:21:58'),
(4, 'Student', '2026-08-21 09:21:58');

-- --------------------------------------------------------

--
-- Table structure for table `clusters`
--

CREATE TABLE `clusters` (
  `id` int(11) NOT NULL,
  `cluster_name` varchar(150) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `is_archived` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `clusters`
--

INSERT INTO `clusters` (`id`, `cluster_name`, `created_at`, `is_archived`) VALUES
(1, 'Office of the President Cluster', '2026-07-13 15:02:10', 0),
(2, 'Administrative and Finance Cluster', '2026-07-13 15:02:10', 0),
(3, 'Academic Cluster', '2026-07-13 15:02:10', 0),
(4, 'Research, Innovation and Collaboration Cluster', '2026-07-13 15:02:10', 0);

-- --------------------------------------------------------
--
-- Table structure for table `offices`
--

CREATE TABLE `offices` (
  `id` int(11) NOT NULL,
  `cluster_name` varchar(150) NOT NULL,
  `office_name` varchar(255) NOT NULL,
  `head_director` varchar(255) DEFAULT 'Not Assigned',
  `email_address` varchar(255) NOT NULL,
  `is_archived` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `offices`
--

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

-- --------------------------------------------------------

--
-- Table structure for table `services`
--

CREATE TABLE `services` (
  `id` int(11) NOT NULL,
  `office_id` int(11) NOT NULL,
  `service_name` varchar(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `services`
--

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

-- --------------------------------------------------------

--
-- Table structure for table `survey_responses`
--

CREATE TABLE `survey_responses` (
  `id` int(11) NOT NULL,
  `office_id` int(11) NOT NULL,
  `respondent_name` varchar(255) DEFAULT 'Anonymous',
  `topic` varchar(100) DEFAULT 'General',
  `region` varchar(100) DEFAULT NULL,
  `cc1` varchar(50) DEFAULT NULL,
  `cc2` varchar(50) DEFAULT NULL,
  `cc3` varchar(50) DEFAULT NULL,
  `sqd0` int(11) DEFAULT NULL,
  `sqd1` int(11) DEFAULT NULL,
  `sqd2` int(11) DEFAULT NULL,
  `sqd3` int(11) DEFAULT NULL,
  `sqd4` int(11) DEFAULT NULL,
  `sqd5` int(11) DEFAULT NULL,
  `sqd6` int(11) DEFAULT NULL,
  `sqd7` int(11) DEFAULT NULL,
  `sqd8` int(11) DEFAULT NULL,
  `comments` text DEFAULT NULL,
  `period_year_quarter` varchar(20) DEFAULT '2026-Q1',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `sentiment` varchar(50) DEFAULT 'Neutral',
  `google_email` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `survey_responses`
--
-- --------------------------------------------------------

--
-- Table structure for table `survey_settings`
--

CREATE TABLE `survey_settings` (
  `id` int(11) NOT NULL,
  `category` varchar(50) NOT NULL,
  `content` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `is_archived` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `survey_settings`
--

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

--
-- Indexes for dumped tables
--

--
-- Indexes for table `admin_logs`
--
ALTER TABLE `admin_logs`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `client_accounts`
--
ALTER TABLE `client_accounts`
  ADD PRIMARY KEY (`email`);

--
-- Indexes for table `client_profiles`
--
ALTER TABLE `client_profiles`
  ADD PRIMARY KEY (`id`),
  ADD KEY `survey_response_id` (`survey_response_id`);

--
-- Indexes for table `client_types`
--
ALTER TABLE `client_types`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `type_name` (`type_name`);

--
-- Indexes for table `clusters`
--
ALTER TABLE `clusters`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `cluster_name` (`cluster_name`);
--
-- Indexes for table `offices`
--
ALTER TABLE `offices`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `services`
--
ALTER TABLE `services`
  ADD PRIMARY KEY (`id`),
  ADD KEY `office_id` (`office_id`);

--
-- Indexes for table `survey_responses`
--
ALTER TABLE `survey_responses`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_office_google_email` (`office_id`,`google_email`);

--
-- Indexes for table `survey_settings`
--
ALTER TABLE `survey_settings`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `admin_logs`
--
ALTER TABLE `admin_logs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=12;

--
-- AUTO_INCREMENT for table `client_profiles`
--
ALTER TABLE `client_profiles`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;

--
-- AUTO_INCREMENT for table `client_types`
--
ALTER TABLE `client_types`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `clusters`
--
ALTER TABLE `clusters`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=10;

--
-- AUTO_INCREMENT for table `offices`
--
ALTER TABLE `offices`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=45;

--
-- AUTO_INCREMENT for table `services`
--
ALTER TABLE `services`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=80;

--
-- AUTO_INCREMENT for table `survey_responses`
--
ALTER TABLE `survey_responses`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;

--
-- AUTO_INCREMENT for table `survey_settings`
--
ALTER TABLE `survey_settings`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=13;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `client_profiles`
--
ALTER TABLE `client_profiles`
  ADD CONSTRAINT `client_profiles_ibfk_1` FOREIGN KEY (`survey_response_id`) REFERENCES `survey_responses` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `services`
--
ALTER TABLE `services`
  ADD CONSTRAINT `services_ibfk_1` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `survey_responses`
--
ALTER TABLE `survey_responses`
  ADD CONSTRAINT `survey_responses_ibfk_1` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;

