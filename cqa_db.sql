-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Aug 07, 2026 at 04:38 PM
-- Server version: 8.0.42
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
-- Table structure for table `client_profiles`
--

CREATE TABLE `client_profiles` (
  `id` int NOT NULL,
  `survey_response_id` int NOT NULL,
  `respondent_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT 'Anonymous',
  `client_type` varchar(100) COLLATE utf8mb4_general_ci DEFAULT 'Citizen',
  `age` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `gender` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `region` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `email` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `client_profiles`
--

INSERT INTO `client_profiles` (`id`, `survey_response_id`, `respondent_name`, `client_type`, `age`, `gender`, `region`, `email`, `created_at`) VALUES
(1, 13, 'Anonymous', 'Citizen', 'Not Specified', 'Not Specified', 'Not Specified', 'Not Specified', '2026-07-13 14:18:34'),
(2, 14, 'Anonymous', 'Citizen', 'Not Specified', 'Not Specified', 'Not Specified', 'Not Specified', '2026-07-13 14:36:34'),
(3, 15, 'kenneth', 'Business', '19-24', 'Male', 'Region V - Bicol Region', 'op@cspc.edu.ph', '2026-07-13 14:46:48'),
(4, 16, 'namemo', 'Government', '19-24', 'Male', 'NCR - National Capital Region', 'frobis@gmail.com', '2026-07-24 12:34:16'),
(5, 17, 'csd', 'Business', '19-24', 'Not Specified', 'NCR - National Capital Region', 'frobis@gmail.com', '2026-07-24 12:43:03'),
(6, 18, 'bebe', 'Citizen', '25-39', 'Male', 'Region I - Ilocos Region', '09630153103', '2026-07-24 13:05:43'),
(7, 19, 'Arnel Marquina', 'Business', '18 and below', 'Not Specified', 'Region V - Bicol Region', 'arnelmarquina@gmail.com', '2026-08-07 14:03:19');

-- --------------------------------------------------------

--
-- Table structure for table `clusters`
--

CREATE TABLE `clusters` (
  `id` int NOT NULL,
  `cluster_name` varchar(150) COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `clusters`
--

INSERT INTO `clusters` (`id`, `cluster_name`, `created_at`) VALUES
(1, 'Office of the President Cluster', '2026-07-13 15:02:10'),
(2, 'Administrative and Finance Cluster', '2026-07-13 15:02:10'),
(3, 'Academic Cluster', '2026-07-13 15:02:10'),
(4, 'Research, Innovation and Collaboration Cluster', '2026-07-13 15:02:10'),
(6, 'MICT', '2026-07-13 15:03:58'),
(9, 'SASO', '2026-07-13 15:21:47');

-- --------------------------------------------------------

--
-- Table structure for table `offices`
--

CREATE TABLE `offices` (
  `id` int NOT NULL,
  `cluster_name` varchar(150) COLLATE utf8mb4_general_ci NOT NULL,
  `office_name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `head_director` varchar(255) COLLATE utf8mb4_general_ci DEFAULT 'Not Assigned',
  `email_address` varchar(255) COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `offices`
--

INSERT INTO `offices` (`id`, `cluster_name`, `office_name`, `head_director`, `email_address`) VALUES
(1, 'Office of the President Cluster', 'OFFICE OF THE PRESIDENT', 'Not Assigned', 'op@cspc.edu.ph'),
(2, 'Office of the President Cluster', 'VICE PRESIDENT FOR ACADEMIC AFFAIRS OFFICE', 'Not Assigned', 'vpaa@cspc.edu.ph'),
(3, 'Office of the President Cluster', 'VICE PRESIDENT FOR ADMINISTRATION AND FINANCE OFFICE', 'Not Assigned', 'vpaf@cspc.edu.ph'),
(4, 'Office of the President Cluster', 'VICE PRESIDENT FOR RESEARCH, INNOVATION AND COLLABORATION OFFICE', 'Not Assigned', 'vpric@cspc.edu.ph'),
(5, 'Office of the President Cluster', 'CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', 'Not Assigned', 'cirl@cspc.edu.ph'),
(6, 'Office of the President Cluster', 'INSTITUTIONAL PLANNING AND DEVELOPMENT OFFICE', 'Not Assigned', 'ipdo@cspc.edu.ph'),
(7, 'Office of the President Cluster', 'INTERNAL AUDIT UNIT', 'Not Assigned', 'iau@cspc.edu.ph'),
(8, 'Administrative and Finance Cluster', 'HUMAN RESOURCE MANAGEMENT AND DEVELOPMENT OFFICE', 'Not Assigned', 'hrmdo@cspc.edu.ph'),
(9, 'Administrative and Finance Cluster', 'RECORDS AND FREEDOM OF INFORMATION OFFICE', 'Not Assigned', 'rfoi@cspc.edu.ph'),
(10, 'Administrative and Finance Cluster', 'HEALTH SERVICES UNIT', 'Not Assigned', 'hsu@cspc.edu.ph'),
(11, 'Administrative and Finance Cluster', 'GENERAL SERVICES UNIT', 'Not Assigned', 'gsu@cspc.edu.ph'),
(12, 'Administrative and Finance Cluster', 'SUPPLY AND PROPERTY MANAGEMENT UNIT', 'Not Assigned', 'spmu@cspc.edu.ph'),
(13, 'Administrative and Finance Cluster', 'PROJECT MANAGEMENT UNIT', 'Not Assigned', 'pmu@cspc.edu.ph'),
(14, 'Administrative and Finance Cluster', 'INFORMATION AND COMMUNICATIONS TECHNOLOGY UNIT', 'Not Assigned', 'ictu@cspc.edu.ph'),
(15, 'Administrative and Finance Cluster', 'ACCOUNTING UNIT', 'Not Assigned', 'accounting@cspc.edu.ph'),
(16, 'Administrative and Finance Cluster', 'BUDGET UNIT', 'Not Assigned', 'budget@cspc.edu.ph'),
(17, 'Administrative and Finance Cluster', 'CASH UNIT', 'Not Assigned', 'cash@cspc.edu.ph'),
(18, 'Administrative and Finance Cluster', 'PRODUCTION AND AUXILIARY SERVICES', 'Not Assigned', 'pas@cspc.edu.ph'),
(19, 'Administrative and Finance Cluster', 'CENTER FOR RINCONADA CULTURE AND ARTS', 'Not Assigned', 'crca@cspc.edu.ph'),
(20, 'Academic Cluster', 'COLLEGE OF ENGINEERING AND ARCHITECTURE', 'Not Assigned', 'cea@cspc.edu.ph'),
(21, 'Academic Cluster', 'COLLEGE OF HEALTH_SCIENCES', 'Not Assigned', 'chs@cspc.edu.ph'),
(22, 'Academic Cluster', 'BUHI CAMPUSs', 'Not Assigned', 'buhi@cspc.edu.ph'),
(23, 'Academic Cluster', 'INFORMATION AND ALUMNI AFFAIRS UNIT AND BROADCAST CENTER', 'Not Assigned', 'iaau@cspc.edu.ph'),
(24, 'Research, Innovation and Collaboration Cluster', 'RESEARCH AND DEVELOPMENT SERVICES OFFICE', 'Not Assigned', 'rdso@cspc.edu.ph'),
(25, 'Research, Innovation and Collaboration Cluster', 'CENTER FOR EXTENSION AND COMMUNITY SERVICES', 'Not Assigned', 'cecs@cspc.edu.ph'),
(26, 'Research, Innovation and Collaboration Cluster', 'PRODUCTION AND AUXILIARY SERVICES', 'Not Assigned', 'pas@cspc.edu.ph'),
(27, 'Research, Innovation and Collaboration Cluster', 'CENTER FOR RINCONADA CULTURE AND ARTS', 'Not Assigned', 'crca@cspc.edu.ph'),
(28, 'MICT', 'ccs', 'Not Assigned', 'ccs@my.edu.ph'),
(29, 'SASO', 'Admission offices', 'Not AssigneAd', 'saso@cspc.edu.ph');

-- --------------------------------------------------------

--
-- Table structure for table `survey_responses`
--

CREATE TABLE `survey_responses` (
  `id` int NOT NULL,
  `office_id` int NOT NULL,
  `respondent_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT 'Anonymous',
  `topic` varchar(100) COLLATE utf8mb4_general_ci DEFAULT 'General',
  `region` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `cc1` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `cc2` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `cc3` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `sqd0` int DEFAULT NULL,
  `sqd1` int DEFAULT NULL,
  `sqd2` int DEFAULT NULL,
  `sqd3` int DEFAULT NULL,
  `sqd4` int DEFAULT NULL,
  `sqd5` int DEFAULT NULL,
  `sqd6` int DEFAULT NULL,
  `sqd7` int DEFAULT NULL,
  `sqd8` int DEFAULT NULL,
  `comments` text COLLATE utf8mb4_general_ci,
  `period_year_quarter` varchar(20) COLLATE utf8mb4_general_ci DEFAULT '2026-Q1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `survey_responses`
--

INSERT INTO `survey_responses` (`id`, `office_id`, `respondent_name`, `topic`, `region`, `cc1`, `cc2`, `cc3`, `sqd0`, `sqd1`, `sqd2`, `sqd3`, `sqd4`, `sqd5`, `sqd6`, `sqd7`, `sqd8`, `comments`, `period_year_quarter`, `created_at`) VALUES
(1, 15, 'Anonymous', 'General', NULL, 'I know what a CC is but I did not see this office\'', 'Difficult to see', 'Somewhat helped', 2, 2, 2, 2, 2, 2, 0, 0, 2, 'pakaraya', '2026-Q1', '2026-07-10 05:32:37'),
(2, 22, 'Anonymous', 'General', NULL, 'I do not know what a CC is and I did not see one i', 'Not visible at all', 'N/A', 1, 1, 1, 1, 1, 1, 1, 1, 1, 'dinalugod', '2026-Q1', '2026-07-10 05:34:47'),
(3, 6, 'Anonymous', 'General', NULL, 'I do not know what a CC is and I did not see one i', 'Not visible at all', 'Did not help', 2, 1, 1, 1, 4, 4, 4, 4, 4, 'hehehe', '2026-Q1', '2026-07-10 05:36:35'),
(4, 27, 'Anonymous', 'General', NULL, 'I know what a CC is but I did not see this office\'', 'Difficult to see', 'N/A', 5, 5, 5, 5, 5, 5, 5, 5, 5, 'lupet', '2026-Q1', '2026-07-10 05:37:32'),
(5, 22, 'Anonymous', 'General', NULL, NULL, NULL, NULL, 1, 1, 1, 1, 1, 1, 1, 1, 1, 'nice', '2026-Q1', '2026-07-10 05:49:45'),
(6, 15, 'Anonymous', 'General', NULL, NULL, NULL, NULL, 2, 2, 2, 2, 2, 2, 2, 2, 2, 'hehe', '2026-Q1', '2026-07-10 06:00:20'),
(7, 6, 'Anonymous', 'General', NULL, NULL, NULL, NULL, 1, 1, 1, 1, 1, 1, 1, 1, 1, 'nhye', '2026-Q1', '2026-07-10 06:01:37'),
(8, 2, 'Anonymous', 'General', NULL, NULL, NULL, NULL, 1, 1, 1, 1, 1, 1, 1, 1, 1, 'pakaray', '2026-Q1', '2026-07-10 06:10:10'),
(9, 2, 'Anonymous', 'General', NULL, 'I know what a CC is but I did not see this office\'', 'Easy to see', 'Helped very much', 5, 5, 5, 5, 5, 5, 5, 5, 5, 'dsds', '2026-Q1', '2026-07-10 06:17:29'),
(10, 2, 'Anonymous', 'General', NULL, 'I know what a CC is but I did not see this office\'', 'Not visible at all', 'Helped very much', 4, 4, 4, 5, 5, 5, 5, 5, 5, 'nc nc', '2026-Q1', '2026-07-10 06:23:26'),
(11, 1, 'Anonymous', 'General', NULL, 'I learned of the CC only when I saw this office\'s ', 'Difficult to see', 'Helped very much', 5, 5, 5, 5, 5, 5, 5, 5, 5, 'lupetmo', '2026-Q1', '2026-07-10 06:45:04'),
(12, 15, 'Anonymous', 'General', NULL, 'I know what a CC is but I did not see this office\'', 'Difficult to see', 'Somewhat helped', 1, 1, 1, 1, 1, 1, 1, 1, 1, 'nyenye', '2026-Q1', '2026-07-13 13:19:02'),
(13, 27, 'Anonymous', 'General', NULL, 'I know what a CC is and I saw this office\'s CC.', 'Difficult to see', 'Did not help', 5, 5, 5, 5, 5, 5, 5, 5, 5, 'AHJSHWJH', '2026-Q1', '2026-07-13 14:18:34'),
(14, 27, 'Anonymous', 'General', 'Not Specified', 'I know what a CC is and I saw this office\'s CC.', 'Easy to see', 'N/A', 5, 5, 5, 5, 5, 5, 5, 5, 5, 'hahaha', '2026-Q1', '2026-07-13 14:36:34'),
(15, 27, 'kenneth', 'General', 'Region V - Bicol Region', 'I know what a CC is and I saw this office\'s CC.', 'Easy to see', 'Somewhat helped', 4, 4, 4, 4, 4, 4, 4, 4, 4, 'kok', '2026-Q1', '2026-07-13 14:46:48'),
(16, 16, 'namemo', 'General', 'NCR - National Capital Region', 'I know what a CC is and I saw this office\'s CC.', 'Easy to see', 'Helped very much', 5, 5, 5, 5, 5, 4, 4, 4, 4, 'lupet nya', '2026-Q1', '2026-07-24 12:34:16'),
(17, 21, 'csd', 'General', 'NCR - National Capital Region', 'I know what a CC is and I saw this office\'s CC.', 'Easy to see', 'Helped very much', 2, 2, 2, 2, 2, 2, 2, 2, 2, 'araymopo', '2026-Q1', '2026-07-24 12:43:03'),
(18, 8, 'bebe', 'General', 'Region I - Ilocos Region', 'I do not know what a CC is and I did not see one i', 'Not visible at all', 'Did not help', 2, 2, 2, 2, 2, 2, 2, 2, 2, 'awawaw', 'Jul - Dec 2026', '2026-07-24 13:05:43'),
(19, 25, 'Arnel Marquina', 'General', 'Region V - Bicol Region', 'I know what a CC is but I did not see this office\'s CC.', 'Easy to see', 'Helped very much', 3, 3, 3, 3, 3, 3, 3, 3, 3, 'need improvement', 'Jul - Dec 2026', '2026-08-07 14:03:19');

-- --------------------------------------------------------

--
-- Table structure for table `survey_settings`
--

CREATE TABLE `survey_settings` (
  `id` int NOT NULL,
  `category` varchar(50) COLLATE utf8mb4_general_ci NOT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `survey_settings`
--

INSERT INTO `survey_settings` (`id`, `category`, `content`, `created_at`) VALUES
(1, 'sqd', 'I am satisfied with the service that I availed.', '2026-07-13 13:03:02'),
(2, 'sqd', 'I spent a reasonable amount of time for my transaction.', '2026-07-13 13:03:02'),
(3, 'sqd', 'The office followed the transaction\'s requirements and steps based on the information provided.', '2026-07-13 13:03:02'),
(4, 'sqd', 'The steps (including payment) I needed to do for my transaction were easy and simple.', '2026-07-13 13:03:02'),
(5, 'sqd', 'I easily found information about my transaction from the office or its website.', '2026-07-13 13:03:02'),
(6, 'sqd', 'I paid a reasonable amount of fees for my transaction.', '2026-07-13 13:03:02'),
(7, 'sqd', 'I feel the office was fair to everyone, or \"walang palakasan\", during my transaction.', '2026-07-13 13:03:02'),
(8, 'sqd', 'I was treated courteously by the staff, and (if asked for help) the staff was helpful.', '2026-07-13 13:03:02'),
(9, 'sqd', 'I got what I needed from the government office, or (if denied) denial of request was sufficiently explained to me.', '2026-07-13 13:03:02'),
(10, 'cc', 'Which of the following best describes your awareness of a CC?', '2026-07-13 13:03:02'),
(11, 'cc', 'If aware of CC (answered 1-3 in CC1), would you say that the CC of this office was...?', '2026-07-13 13:03:02'),
(12, 'cc', 'If aware of CC (answered 1-3 in CC1), how much did the CC help you in your transaction?', '2026-07-13 13:03:02');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `client_profiles`
--
ALTER TABLE `client_profiles`
  ADD PRIMARY KEY (`id`),
  ADD KEY `survey_response_id` (`survey_response_id`);

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
-- Indexes for table `survey_responses`
--
ALTER TABLE `survey_responses`
  ADD PRIMARY KEY (`id`),
  ADD KEY `office_id` (`office_id`);

--
-- Indexes for table `survey_settings`
--
ALTER TABLE `survey_settings`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `client_profiles`
--
ALTER TABLE `client_profiles`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;

--
-- AUTO_INCREMENT for table `clusters`
--
ALTER TABLE `clusters`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=10;

--
-- AUTO_INCREMENT for table `offices`
--
ALTER TABLE `offices`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=30;

--
-- AUTO_INCREMENT for table `survey_responses`
--
ALTER TABLE `survey_responses`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=20;

--
-- AUTO_INCREMENT for table `survey_settings`
--
ALTER TABLE `survey_settings`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=13;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `client_profiles`
--
ALTER TABLE `client_profiles`
  ADD CONSTRAINT `client_profiles_ibfk_1` FOREIGN KEY (`survey_response_id`) REFERENCES `survey_responses` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `survey_responses`
--
ALTER TABLE `survey_responses`
  ADD CONSTRAINT `survey_responses_ibfk_1` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
