-- ============================================================================
-- Cluster restructuring migration:
--   1. Remove the "Not Assigned" cluster and every office under it
--      (Internet Center, VPREPED, TESDA Office).
--   2. Rename "PRESIDENT CLUSTER" -> "Office of the president cluster"
--      (all of its offices move with it).
--   3. Rename "RIC Cluster" -> "Reasearch, Innovation and Collaboration Cluster"
--      (all of its offices move with it).
--
-- This is a live-database migration (UPDATE/DELETE), not a re-seed. It targets
-- the actual `clusters`/`offices` rows currently in your MySQL instance,
-- whatever their id values are. Cluster names are the join key the app uses
-- (offices.cluster_name is a free-text copy of clusters.cluster_name, kept in
-- sync by server.js's own rename logic), so this migration follows that same
-- pattern instead of hardcoding ids.
--
-- BACK UP FIRST:
--   mysqldump -u root cqa_db clusters offices > cqa_db_backup_before_cluster_rename.sql
--
-- Then run:
--   mysql -u root cqa_db < admin-portal/migrations/rename_and_remove_clusters.sql
-- ============================================================================

START TRANSACTION;

-- 1. Drop "Not Assigned" cluster and its offices entirely.
DELETE FROM offices WHERE cluster_name = 'Not Assigned';
DELETE FROM clusters WHERE cluster_name = 'Not Assigned';

-- 2. Rename PRESIDENT CLUSTER -> Office of the president cluster.
UPDATE offices SET cluster_name = 'Office of the president cluster'
  WHERE cluster_name = 'PRESIDENT CLUSTER';
UPDATE clusters SET cluster_name = 'Office of the president cluster'
  WHERE cluster_name = 'PRESIDENT CLUSTER';

-- 3. Rename RIC Cluster -> Reasearch, Innovation and Collaboration Cluster.
UPDATE offices SET cluster_name = 'Reasearch, Innovation and Collaboration Cluster'
  WHERE cluster_name = 'RIC Cluster';
UPDATE clusters SET cluster_name = 'Reasearch, Innovation and Collaboration Cluster'
  WHERE cluster_name = 'RIC Cluster';

COMMIT;
