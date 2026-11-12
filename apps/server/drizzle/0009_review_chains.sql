CREATE TABLE "review_counters" (
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "review_counters_project_id_scope_pk" PRIMARY KEY("project_id","scope")
);
--> statement-breakpoint
CREATE TABLE "workflow_reminders" (
	"instance_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_reminders_instance_id_step_index_kind_pk" PRIMARY KEY("instance_id","step_index","kind")
);
--> statement-breakpoint
ALTER TABLE "review_files" ADD COLUMN "step_codes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_files" ADD COLUMN "final_label" text;--> statement-breakpoint
ALTER TABLE "review_files" ADD COLUMN "stopped_at_step" integer;--> statement-breakpoint
ALTER TABLE "review_files" ADD COLUMN "copy_folder_id" uuid;--> statement-breakpoint
ALTER TABLE "review_files" ADD COLUMN "copy_unresolved" jsonb;--> statement-breakpoint
ALTER TABLE "review_marks" ADD COLUMN "option_code" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "target_pattern" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "target_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD COLUMN "stage_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "chain_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_counters" ADD CONSTRAINT "review_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_reminders" ADD CONSTRAINT "workflow_reminders_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_code" ON "reviews" USING btree ("project_id","code") WHERE code IS NOT NULL;