-- Run once as a database administrator on a separately recovered primary.
-- Pre-provision an authority ID and use the same ID on every participating host.
CREATE SCHEMA once_admission;
CREATE TABLE once_admission.authorities (
  authority_id text PRIMARY KEY
);
CREATE TABLE once_admission.reservations (
  authority_id text NOT NULL REFERENCES once_admission.authorities (authority_id),
  operation_id text NOT NULL,
  fingerprint text NOT NULL,
  PRIMARY KEY (authority_id, operation_id)
);
