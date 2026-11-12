-- The interface became multi-lingual with English as the default (docs/architecture/i18n.md).
-- Accounts that existed before used the Turkish interface: keep it for them. New accounts start
-- in English; anyone can switch from the top bar.
UPDATE "users" SET "prefs" = COALESCE("prefs", '{}'::jsonb) || '{"language": "tr"}'::jsonb WHERE NOT (COALESCE("prefs", '{}'::jsonb) ? 'language');
