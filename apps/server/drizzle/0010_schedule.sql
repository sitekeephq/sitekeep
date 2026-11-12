CREATE TABLE "activity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"activity_code" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"global_ids" text[],
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"code" text NOT NULL,
	"external_id" text,
	"wbs_path" text,
	"name" text NOT NULL,
	"start" date,
	"finish" date,
	"baseline_start" date,
	"baseline_finish" date,
	"actual_start" date,
	"actual_finish" date,
	"percent_complete" real DEFAULT 0 NOT NULL,
	"duration_days" real,
	"critical" boolean DEFAULT false NOT NULL,
	"milestone" boolean DEFAULT false NOT NULL,
	"summary" boolean DEFAULT false NOT NULL,
	"resource" text,
	"parent_id" uuid,
	"outline_level" integer DEFAULT 1 NOT NULL,
	"sort_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"pred_id" uuid NOT NULL,
	"succ_id" uuid NOT NULL,
	"type" text DEFAULT 'FS' NOT NULL,
	"lag_days" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_name" text,
	"data_date" date,
	"is_baseline" boolean DEFAULT false NOT NULL,
	"activity_count" integer DEFAULT 0 NOT NULL,
	"start_date" date,
	"finish_date" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_links" ADD CONSTRAINT "activity_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_links" ADD CONSTRAINT "activity_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_dependencies" ADD CONSTRAINT "schedule_dependencies_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_dependencies" ADD CONSTRAINT "schedule_dependencies_pred_id_schedule_activities_id_fk" FOREIGN KEY ("pred_id") REFERENCES "public"."schedule_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_dependencies" ADD CONSTRAINT "schedule_dependencies_succ_id_schedule_activities_id_fk" FOREIGN KEY ("succ_id") REFERENCES "public"."schedule_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_links_activity_idx" ON "activity_links" USING btree ("series_id","activity_code");--> statement-breakpoint
CREATE INDEX "activity_links_target_idx" ON "activity_links" USING btree ("kind","target_id");--> statement-breakpoint
CREATE INDEX "schedule_activities_order_idx" ON "schedule_activities" USING btree ("schedule_id","sort_index");--> statement-breakpoint
CREATE INDEX "schedule_activities_code_idx" ON "schedule_activities" USING btree ("schedule_id","code");--> statement-breakpoint
CREATE INDEX "schedule_dependencies_schedule_idx" ON "schedule_dependencies" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "schedules_project_idx" ON "schedules" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_series_version" ON "schedules" USING btree ("series_id","version");