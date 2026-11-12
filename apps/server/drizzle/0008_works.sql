CREATE TABLE "work_counters" (
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "work_counters_project_id_scope_pk" PRIMARY KEY("project_id","scope")
);
--> statement-breakpoint
CREATE TABLE "work_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"message" text,
	"details" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"role" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_receipts" (
	"work_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_receipts_work_id_company_id_pk" PRIMARY KEY("work_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "work_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"numbering_pattern" text NOT NULL,
	"counter_group" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"statuses" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_workflow_template_id" uuid,
	"icon" text,
	"color" text,
	"built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_template_work_options" (
	"template_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"auto_transmittal" boolean DEFAULT false NOT NULL,
	"recipient_company_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"purpose" text DEFAULT 'bilgi' NOT NULL,
	"send" boolean DEFAULT true NOT NULL,
	"include" text DEFAULT 'approved' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"number" text NOT NULL,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_company_id" uuid,
	"from_company_id" uuid,
	"to_company_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cc_company_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"assignee_user_id" uuid,
	"due_date" text,
	"reply_required" boolean DEFAULT false NOT NULL,
	"delivery" jsonb,
	"workflow_instance_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "work_counters" ADD CONSTRAINT "work_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_receipts" ADD CONSTRAINT "work_receipts_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_receipts" ADD CONSTRAINT "work_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_receipts" ADD CONSTRAINT "work_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_types" ADD CONSTRAINT "work_types_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_types" ADD CONSTRAINT "work_types_default_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("default_workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_template_work_options" ADD CONSTRAINT "workflow_template_work_options_template_id_workflow_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_template_work_options" ADD CONSTRAINT "workflow_template_work_options_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_type_id_work_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."work_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_owner_company_id_companies_id_fk" FOREIGN KEY ("owner_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_from_company_id_companies_id_fk" FOREIGN KEY ("from_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_workflow_instance_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_events_work_idx" ON "work_events" USING btree ("work_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_links_unique" ON "work_links" USING btree ("work_id","kind","target_id","role");--> statement-breakpoint
CREATE INDEX "work_links_target_idx" ON "work_links" USING btree ("kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_types_key" ON "work_types" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "works_number" ON "works" USING btree ("project_id","type_id","number");--> statement-breakpoint
CREATE INDEX "works_project_idx" ON "works" USING btree ("project_id","type_id","status");