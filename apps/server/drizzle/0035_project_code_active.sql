ALTER TABLE "projects" DROP CONSTRAINT "projects_code_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "projects_code_active" ON "projects" USING btree ("code") WHERE archived = false;