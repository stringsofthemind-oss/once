-- Explicit opt-in migration; never run by runtime recovery. Requires operator
-- review and trusted seeding of schema_version=2/state_digest for each namespace.
BEGIN;
ALTER TABLE once_execution.authorities DROP CONSTRAINT authorities_schema_version_check;
ALTER TABLE once_execution.authorities ADD CHECK(schema_version IN (1,2));
ALTER TABLE once_execution.authorities ADD COLUMN state_digest text;
CREATE TABLE once_execution.host_intents (
  authority_id text NOT NULL REFERENCES once_execution.authorities(authority_id),
  scope text NOT NULL CHECK(length(scope)>0),
  intent_key text NOT NULL CHECK(length(intent_key)>0),
  operation_id text NOT NULL,
  effect_fingerprint text NOT NULL,
  PRIMARY KEY(authority_id,scope,intent_key), UNIQUE(authority_id,operation_id)
);
-- Runtime SELECT only on mappings. Separate admission role SELECT/INSERT.
COMMIT;
