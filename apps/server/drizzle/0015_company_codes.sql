ALTER TABLE "companies" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_code_unique" UNIQUE("code");