-- Explicit operator provisioning on a SEPARATE PostgreSQL cluster/restore domain.
-- No implicit repair or IF NOT EXISTS. Seed metadata/checkpoints out of band.
BEGIN;
CREATE SCHEMA once_continuity;
CREATE TABLE once_continuity.metadata (
  singleton boolean PRIMARY KEY CHECK(singleton),
  witness_id text NOT NULL,
  schema_version integer NOT NULL CHECK(schema_version=1)
);
CREATE TABLE once_continuity.checkpoints (
  authority_id text PRIMARY KEY,
  generation text NOT NULL,
  epoch bigint NOT NULL CHECK(epoch>=0),
  revision bigint NOT NULL CHECK(revision>=0)
);
COMMIT;
