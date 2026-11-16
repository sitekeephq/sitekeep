CREATE TABLE "security_alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject_key" text NOT NULL,
	"user_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audit_id" bigint,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"mailed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_auditor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "security_alert" ADD CONSTRAINT "security_alert_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_alert" ADD CONSTRAINT "security_alert_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_alert_status_idx" ON "security_alert" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "security_alert_subject_idx" ON "security_alert" USING btree ("rule","subject_key","created_at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "audit_personal_ip_idx" ON "audit_personal" USING btree ("ip");