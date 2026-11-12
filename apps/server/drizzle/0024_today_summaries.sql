CREATE TABLE "today_summaries" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"stamp" text,
	"bullets" jsonb,
	"model" text,
	"source" text,
	"generated_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"error" text,
	"error_at" timestamp with time zone,
	CONSTRAINT "today_summaries_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "today_summaries" ADD CONSTRAINT "today_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_summaries" ADD CONSTRAINT "today_summaries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;