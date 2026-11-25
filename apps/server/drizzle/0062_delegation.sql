-- Approval delegation hook (issue #190, workflow/delegation.ts). The delegation itself is the Platform
-- module's; the core only keeps who acted for whom ("X adına Y") and the delegates resolved when a
-- step became current or a work was assigned. Existing rows: no delegate, own answers.
ALTER TABLE "review_marks" ADD COLUMN IF NOT EXISTS "on_behalf_of_user_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD COLUMN IF NOT EXISTS "on_behalf_of_user_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD COLUMN IF NOT EXISTS "step_delegates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN IF NOT EXISTS "assignee_delegates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "review_marks" ADD CONSTRAINT "review_marks_on_behalf_of_user_id_users_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_on_behalf_of_user_id_users_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
