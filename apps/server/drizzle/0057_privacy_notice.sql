CREATE TABLE "privacy_notice_acceptances" (
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"via" text NOT NULL,
	CONSTRAINT "privacy_notice_acceptances_user_id_version_pk" PRIMARY KEY("user_id","version")
);
--> statement-breakpoint
ALTER TABLE "privacy_notice_acceptances" ADD CONSTRAINT "privacy_notice_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;