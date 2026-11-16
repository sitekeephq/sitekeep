CREATE TABLE "user_two_factor" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_step" bigint,
	"recovery_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_two_factor" ADD CONSTRAINT "user_two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;