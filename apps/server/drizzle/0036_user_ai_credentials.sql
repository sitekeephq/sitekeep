CREATE TABLE "user_ai_credentials" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"api_key_enc" text,
	"model" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ai_credentials_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "user_ai_credentials" ADD CONSTRAINT "user_ai_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
