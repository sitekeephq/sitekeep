CREATE TABLE "work_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"rev" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"workflow_instance_id" uuid,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comment" text,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"outcome_code" text,
	"outcome_label" text,
	"response" text,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "parent_work_id" uuid;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "work_revisions" ADD CONSTRAINT "work_revisions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_revisions" ADD CONSTRAINT "work_revisions_workflow_instance_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_revisions" ADD CONSTRAINT "work_revisions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_revisions_rev" ON "work_revisions" USING btree ("work_id","rev");--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_parent_work_id_works_id_fk" FOREIGN KEY ("parent_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "works_parent_idx" ON "works" USING btree ("parent_work_id");