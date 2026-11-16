CREATE TABLE "delivery_deliverables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" uuid,
	"code" text NOT NULL,
	"code_norm" text NOT NULL,
	"title" text NOT NULL,
	"discipline" text,
	"doc_type" text,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_shared" date,
	"due_published" date,
	"notes" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"due_date" date,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_team_leads" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_deliverables" ADD CONSTRAINT "delivery_deliverables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_deliverables" ADD CONSTRAINT "delivery_deliverables_team_id_project_roles_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."project_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_deliverables" ADD CONSTRAINT "delivery_deliverables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_milestones" ADD CONSTRAINT "delivery_milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_team_leads" ADD CONSTRAINT "delivery_team_leads_team_id_project_roles_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."project_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_team_leads" ADD CONSTRAINT "delivery_team_leads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_team_leads" ADD CONSTRAINT "delivery_team_leads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_deliverables_code" ON "delivery_deliverables" USING btree ("project_id","code_norm");--> statement-breakpoint
CREATE INDEX "delivery_deliverables_team" ON "delivery_deliverables" USING btree ("project_id","team_id");--> statement-breakpoint
CREATE INDEX "delivery_milestones_project" ON "delivery_milestones" USING btree ("project_id");