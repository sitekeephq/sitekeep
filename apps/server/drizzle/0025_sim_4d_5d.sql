CREATE TABLE "cost_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"unit_price" double precision NOT NULL,
	"currency" text DEFAULT 'TRY' NOT NULL,
	"category" text,
	"poz_code" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"cost_item_id" uuid,
	"match" jsonb NOT NULL,
	"quantity" text DEFAULT 'count' NOT NULL,
	"multiplier" real DEFAULT 1 NOT NULL,
	"series_id" uuid,
	"activity_code" text,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_link_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"activity_code" text,
	"match" jsonb NOT NULL,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"applied_version_id" uuid,
	"applied_at" timestamp with time zone,
	"applied_count" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_links" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_rules" ADD CONSTRAINT "cost_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_rules" ADD CONSTRAINT "cost_rules_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_rules" ADD CONSTRAINT "cost_rules_cost_item_id_cost_items_id_fk" FOREIGN KEY ("cost_item_id") REFERENCES "public"."cost_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_rules" ADD CONSTRAINT "cost_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_link_rules" ADD CONSTRAINT "schedule_link_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_link_rules" ADD CONSTRAINT "schedule_link_rules_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_link_rules" ADD CONSTRAINT "schedule_link_rules_applied_version_id_file_versions_id_fk" FOREIGN KEY ("applied_version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_link_rules" ADD CONSTRAINT "schedule_link_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_items_project_code" ON "cost_items" USING btree ("project_id","code");--> statement-breakpoint
CREATE INDEX "cost_rules_project_idx" ON "cost_rules" USING btree ("project_id","file_id");--> statement-breakpoint
CREATE INDEX "schedule_link_rules_series_idx" ON "schedule_link_rules" USING btree ("series_id","file_id");--> statement-breakpoint
ALTER TABLE "activity_links" ADD CONSTRAINT "activity_links_rule_id_schedule_link_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."schedule_link_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Live report refresh (see 0020_report_stamps): 5D tables bump the "cost" scope, 4D link rules and links the "schedule" scope.
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "cost_items" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "cost_items" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "cost_items" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "cost_rules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "cost_rules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "cost_rules" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('cost');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "schedule_link_rules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "schedule_link_rules" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "schedule_link_rules" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');
--> statement-breakpoint
CREATE TRIGGER report_stamp_insert AFTER INSERT ON "activity_links" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');
--> statement-breakpoint
CREATE TRIGGER report_stamp_update AFTER UPDATE ON "activity_links" REFERENCING NEW TABLE AS report_new_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');
--> statement-breakpoint
CREATE TRIGGER report_stamp_delete AFTER DELETE ON "activity_links" REFERENCING OLD TABLE AS report_old_rows FOR EACH STATEMENT EXECUTE FUNCTION report_stamp_bump('schedule');
