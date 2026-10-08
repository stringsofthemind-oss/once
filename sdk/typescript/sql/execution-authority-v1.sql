-- EXPLICIT operator provisioning only. Never run automatically on SDK startup.
-- Intentionally no IF NOT EXISTS: partial/missing/incompatible state is an error.
-- Provision a new authority and its independent witness together, out of band.
BEGIN;
CREATE SCHEMA once_execution;
CREATE TABLE once_execution.authorities (
  authority_id text PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  generation text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  revision bigint NOT NULL CHECK (revision >= 0)
);
CREATE TABLE once_execution.operations (
  authority_id text NOT NULL REFERENCES once_execution.authorities(authority_id),
  id text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('CLAIMED','UNKNOWN','CONFIRMED')),
  result_json text,
  owner text,
  lease_until bigint,
  PRIMARY KEY (authority_id,id),
  CHECK ((state = 'CLAIMED' AND owner IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'CLAIMED' AND owner IS NULL AND lease_until IS NULL)),
  CHECK ((state = 'CONFIRMED' AND result_json IS NOT NULL)
      OR (state <> 'CONFIRMED' AND result_json IS NULL))
);
COMMIT;
