-- ISO-4: append-only, hash-chained audit log (docs/features/AUDIT_LOG.md; ISO 19650-1 §12, -2 §5.1.7).
--
-- Every new row is chained to the one before it: hash = sha256(prev_hash || '|' || canonical row).
-- Inserts are serialised with a transaction-level advisory lock, and the row id is taken from the
-- sequence under that lock, so id order is chain order (the column default is dropped: the trigger
-- is the only source of ids, and an insert with the trigger disabled fails on the missing id). Rows that existed before this migration keep hash = null;
-- the genesis row "audit.chain_started" opens the chain. Updates, deletes and truncation are refused.
-- Works on PostgreSQL and PGlite (sha256() is built in since PostgreSQL 11; no extension needed).

-- Canonical text of a row: a JSON array of its fields in a fixed order, the time in UTC with microseconds.
CREATE OR REPLACE FUNCTION audit_log_canonical(r audit_log) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array(
    r.id, r.project_id, r.user_id, r.action, r.target_type, r.target_id, r.details,
    to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), r.ip, r.user_agent
  )::text
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_hash(prev text, r audit_log) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(coalesce(prev, '') || '|' || audit_log_canonical(r), 'UTF8')), 'hex')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- One writer at a time until commit; key = hashtext('sitekeep.audit_log').
  PERFORM pg_advisory_xact_lock(hashtext('sitekeep.audit_log'));
  NEW.id := nextval(pg_get_serial_sequence('audit_log', 'id'));
  SELECT a.hash INTO NEW.prev_hash FROM audit_log a WHERE a.hash IS NOT NULL ORDER BY a.id DESC LIMIT 1;
  NEW.hash := audit_log_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "id" DROP DEFAULT;
--> statement-breakpoint
CREATE TRIGGER audit_log_chain BEFORE INSERT ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint
-- Rows can no longer change: the report refresh only needs the insert stamp (0020_report_stamps).
DROP TRIGGER IF EXISTS report_stamp_update ON "audit_log";
--> statement-breakpoint
DROP TRIGGER IF EXISTS report_stamp_delete ON "audit_log";
--> statement-breakpoint
INSERT INTO "audit_log" ("action", "target_type", "details") VALUES ('audit.chain_started', 'system', jsonb_build_object('migration', '0043_audit_chain'));
