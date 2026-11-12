CREATE TABLE "wopi_locks" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"lock_id" text NOT NULL,
	"user_id" uuid,
	"editor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refreshed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "wopi_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"permission" jsonb NOT NULL,
	"post_message_origin" text,
	"editor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "wopi_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "wopi_locks" ADD CONSTRAINT "wopi_locks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wopi_locks" ADD CONSTRAINT "wopi_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wopi_locks" ADD CONSTRAINT "wopi_locks_refreshed_by_users_id_fk" FOREIGN KEY ("refreshed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wopi_tokens" ADD CONSTRAINT "wopi_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wopi_tokens" ADD CONSTRAINT "wopi_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wopi_tokens" ADD CONSTRAINT "wopi_tokens_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wopi_tokens_file_idx" ON "wopi_tokens" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "wopi_tokens_expires_idx" ON "wopi_tokens" USING btree ("expires_at");