CREATE TABLE "audit_personal" (
	"audit_id" bigint PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"user_id" uuid,
	"ip" text,
	"user_agent" text,
	"email" text
);
--> statement-breakpoint
CREATE TABLE "audit_reseal_hash" (
	"reseal_id" bigint NOT NULL,
	"row_id" bigint NOT NULL,
	"old_prev_hash" text,
	"old_hash" text NOT NULL,
	CONSTRAINT "audit_reseal_hash_reseal_id_row_id_pk" PRIMARY KEY("reseal_id","row_id")
);
--> statement-breakpoint
CREATE TABLE "audit_reseal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"from_id" bigint NOT NULL,
	"old_head_id" bigint NOT NULL,
	"old_head_hash" text NOT NULL,
	"new_head_hash" text NOT NULL,
	"rows_rewritten" integer NOT NULL,
	"personal_moved" integer NOT NULL,
	"archive_digest" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "personal_hash" text;--> statement-breakpoint
ALTER TABLE "audit_personal" ADD CONSTRAINT "audit_personal_audit_id_audit_log_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_reseal_hash" ADD CONSTRAINT "audit_reseal_hash_reseal_id_audit_reseal_id_fk" FOREIGN KEY ("reseal_id") REFERENCES "public"."audit_reseal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_personal_at_idx" ON "audit_personal" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_personal_user_idx" ON "audit_personal" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_personal_email_idx" ON "audit_personal" USING btree ("email");--> statement-breakpoint
CREATE INDEX "audit_reseal_hash_old_idx" ON "audit_reseal_hash" USING btree ("old_hash");
--> statement-breakpoint
-- P1-5 (docs/features/AUDIT_LOG.md#personal-data): personal values of audit rows live in audit_personal,
-- which is not chained and can be deleted (retention, erasure). A row written from now on keeps
-- personal_hash, a keyed hash of its personal values, in its chained content. Rows without one hash
-- exactly as before, so every row chained since 0043 still verifies.
CREATE OR REPLACE FUNCTION audit_log_canonical(r audit_log) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN r.personal_hash IS NULL THEN jsonb_build_array(
    r.id, r.project_id, r.user_id, r.action, r.target_type, r.target_id, r.details,
    to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), r.ip, r.user_agent
  ) ELSE jsonb_build_array(
    r.id, r.project_id, r.user_id, r.action, r.target_type, r.target_id, r.details,
    to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), r.ip, r.user_agent, r.personal_hash
  ) END::text
$$;
--> statement-breakpoint
-- The re-seal archive is append-only like the log.
CREATE OR REPLACE FUNCTION audit_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_reseal_immutable BEFORE UPDATE OR DELETE ON "audit_reseal" FOR EACH ROW EXECUTE FUNCTION audit_archive_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_reseal_hash_immutable BEFORE UPDATE OR DELETE ON "audit_reseal_hash" FOR EACH ROW EXECUTE FUNCTION audit_archive_immutable();
--> statement-breakpoint
-- Rows from before the chain (legacy rows of 0043: hash null, below the genesis row) are covered by no
-- hash: their IP address, user agent and e-mail move to audit_personal, 5000 rows at a time. Chained
-- rows are not touched here, since changing them would break the chain; an administrator moves theirs
-- with a re-seal (npm run audit:reseal), an audited maintenance operation.
ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_immutable";
--> statement-breakpoint
DO $$
DECLARE
  genesis bigint := (SELECT min(id) FROM audit_log WHERE hash IS NOT NULL);
  last_id bigint := 0;
  upto bigint;
BEGIN
  LOOP
    SELECT max(b.id) INTO upto FROM (
      SELECT id FROM audit_log WHERE id > last_id AND (genesis IS NULL OR id < genesis) ORDER BY id LIMIT 5000
    ) b;
    EXIT WHEN upto IS NULL;
    INSERT INTO audit_personal (audit_id, at, user_id, ip, user_agent, email)
      SELECT id, at, user_id, ip, user_agent,
        CASE WHEN jsonb_typeof(details) = 'object' AND jsonb_typeof(details->'email') = 'string' THEN lower(details->>'email') END
      FROM audit_log
      WHERE id > last_id AND id <= upto AND hash IS NULL
        AND (ip IS NOT NULL OR user_agent IS NOT NULL OR (jsonb_typeof(details) = 'object' AND details ? 'email'));
    UPDATE audit_log SET ip = NULL, user_agent = NULL,
        details = CASE WHEN jsonb_typeof(details) = 'object' THEN details - 'email' ELSE details END
      WHERE id > last_id AND id <= upto AND hash IS NULL
        AND (ip IS NOT NULL OR user_agent IS NOT NULL OR (jsonb_typeof(details) = 'object' AND details ? 'email'));
    last_id := upto;
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_immutable";
--> statement-breakpoint
-- On the record: what this migration moved, and how many chained rows still hold personal values.
INSERT INTO "audit_log" ("action", "target_type", "details")
SELECT 'audit.personal_split', 'system', jsonb_build_object(
  'migration', '0049_audit_personal',
  'legacyRowsMoved', (SELECT count(*) FROM audit_personal),
  'chainedRowsWithPersonalData', (SELECT count(*) FROM audit_log WHERE hash IS NOT NULL
    AND (ip IS NOT NULL OR user_agent IS NOT NULL OR (jsonb_typeof(details) = 'object' AND jsonb_typeof(details->'email') = 'string')))
);