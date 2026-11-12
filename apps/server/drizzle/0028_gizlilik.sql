CREATE TABLE "outbound_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"connection" text,
	"host" text NOT NULL,
	"method" text NOT NULL,
	"local" boolean NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"bytes_out" integer,
	"bytes_in" integer,
	"status" integer,
	"error" text,
	"duration_ms" integer,
	"user_id" uuid,
	"project_id" uuid,
	"details" jsonb
);
--> statement-breakpoint
CREATE INDEX "outbound_log_at_idx" ON "outbound_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "outbound_log_purpose_idx" ON "outbound_log" USING btree ("purpose","at");--> statement-breakpoint
CREATE INDEX "outbound_log_host_idx" ON "outbound_log" USING btree ("host","at");