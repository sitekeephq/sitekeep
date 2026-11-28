-- Automatic retry of failed jobs with backoff (jobs/errors.ts): a queued job is not started before run_after.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "run_after" timestamp with time zone;
