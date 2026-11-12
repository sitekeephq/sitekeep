CREATE TABLE "ai_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"input" jsonb NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_by" uuid,
	"claimed_by_user" uuid,
	"claimed_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_claimed_by_tokens_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_claimed_by_user_users_id_fk" FOREIGN KEY ("claimed_by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_tasks_project_status_idx" ON "ai_tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "ai_tasks_requester_idx" ON "ai_tasks" USING btree ("requested_by","created_at");