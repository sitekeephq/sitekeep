-- Companies on a project (docs/features/COMPANIES.md, issue #142). Companies stay one registry; this
-- table says which projects a company is on. Non-administrators see a company only through it.
CREATE TABLE IF NOT EXISTS "project_companies" (
	"project_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_companies_project_id_company_id_pk" PRIMARY KEY("project_id","company_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_companies" ADD CONSTRAINT "project_companies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_companies" ADD CONSTRAINT "project_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_companies_company_idx" ON "project_companies" USING btree ("company_id");--> statement-breakpoint
-- Backfill: every company a project already refers to (keep in step with src/projects/companies.ts,
-- syncProjectCompanies). Read-only on every other table; re-runnable (ON CONFLICT DO NOTHING).
INSERT INTO "project_companies" ("project_id", "company_id")
SELECT DISTINCT u.project_id, u.company_id
FROM (
	SELECT pm.project_id, coalesce(pm.company_id, us.company_id) AS company_id FROM "project_members" pm JOIN "users" us ON us.id = pm.user_id
	UNION SELECT project_id, company_id FROM "project_slots"
	UNION SELECT project_id, company_id FROM "project_roles"
	UNION SELECT project_id, company_id FROM "invitations"
	UNION SELECT project_id, assignee_company_id FROM "issues"
	UNION SELECT project_id, owner_company_id FROM "works"
	UNION SELECT project_id, from_company_id FROM "works"
	UNION SELECT project_id, unnest(to_company_ids) FROM "works"
	UNION SELECT project_id, unnest(cc_company_ids) FROM "works"
	UNION SELECT w.project_id, r.company_id FROM "work_receipts" r JOIN "works" w ON w.id = r.work_id
	UNION SELECT project_id, unnest(recipient_company_ids) FROM "workflow_template_work_options"
	UNION SELECT f.project_id, g.subject_id FROM "folder_grants" g JOIN "folders" f ON f.id = g.folder_id WHERE g.subject_type = 'company'
	UNION SELECT t.project_id, c.id FROM "workflow_templates" t
		CROSS JOIN LATERAL jsonb_path_query(t.steps, 'lax $.**.assignees[*] ? (@.type == "company").id') AS a(v)
		JOIN "companies" c ON c.id::text = (a.v #>> '{}')
) u
JOIN "companies" c ON c.id = u.company_id
JOIN "projects" p ON p.id = u.project_id
ON CONFLICT DO NOTHING;
