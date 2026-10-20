-- Apply ONLY on the independently protected witness cluster, with explicit
-- trusted operator provisioning. Missing roots are never seeded by runtime.
BEGIN;
ALTER TABLE once_continuity.metadata DROP CONSTRAINT metadata_schema_version_check;
ALTER TABLE once_continuity.metadata ADD CHECK(schema_version IN (1,2));
ALTER TABLE once_continuity.checkpoints ADD COLUMN state_digest text;
COMMIT;
