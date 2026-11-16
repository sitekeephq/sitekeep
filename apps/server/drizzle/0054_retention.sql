CREATE TABLE "audit_truncation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"before" timestamp with time zone NOT NULL,
	"retention_years" integer NOT NULL,
	"removed_rows" integer NOT NULL,
	"removed_personal" integer NOT NULL,
	"removed_from_id" bigint NOT NULL,
	"removed_to_id" bigint NOT NULL,
	"removed_head_hash" text,
	"new_first_id" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disposal_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid NOT NULL,
	"category" text NOT NULL,
	"count" integer NOT NULL,
	"oldest" timestamp with time zone,
	"newest" timestamp with time zone,
	"basis" text NOT NULL,
	"method" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE INDEX "disposal_log_at_idx" ON "disposal_log" USING btree ("at");
--> statement-breakpoint
-- Retention (issue #85, docs/features/AUDIT_LOG.md#retention-and-truncation): the truncation
-- checkpoints of the audit log and the disposal record are append-only, like the re-seal archive.
CREATE TRIGGER audit_truncation_immutable BEFORE UPDATE OR DELETE ON "audit_truncation" FOR EACH ROW EXECUTE FUNCTION audit_archive_immutable();
--> statement-breakpoint
CREATE TRIGGER disposal_log_immutable BEFORE UPDATE OR DELETE ON "disposal_log" FOR EACH ROW EXECUTE FUNCTION audit_archive_immutable();