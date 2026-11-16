-- Report builder → Platform module (docs/modules/platform.md, issue #82 §2).
-- Generated with drizzle-kit, then edited (as 0042): the generated
--   DROP TABLE "dashboard_versions" CASCADE;
--   DROP TABLE "dashboards" CASCADE;
-- are removed. The tables hold users' dashboards and belong to the Platform module now: its own
-- migrations adopt them (CREATE TABLE IF NOT EXISTS) and the core must never drop or alter them.
-- An installation without the module keeps them untouched. This migration changes nothing; it only
-- moves the snapshot past the two tables so the next generated migration does not drop them.
SELECT 1;
