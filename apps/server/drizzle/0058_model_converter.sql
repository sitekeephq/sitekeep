ALTER TABLE "file_versions" ADD COLUMN IF NOT EXISTS "ifc_key" text;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN IF NOT EXISTS "converter" text;
