import { LocalProtectionError, type LocalAdmissionWitness } from "./local.js";

export interface PostgresAdmissionClient {
  /** A committed, autocommit query against the writable primary. */
  query(sql: string, parameters: string[]): Promise<{ rowCount: number | null }>;
}

const RESERVE = `
  INSERT INTO once_admission.reservations (authority_id, operation_id, fingerprint)
  SELECT authority_id, $2, $3
  FROM once_admission.authorities
  WHERE authority_id = $1
  ON CONFLICT (authority_id, operation_id) DO NOTHING
  RETURNING operation_id
`;

/** Uses a separately administered, pre-provisioned PostgreSQL authority. */
export function createPostgresAdmissionWitness(client: PostgresAdmissionClient, id: string): LocalAdmissionWitness {
  if (typeof client?.query !== "function" || typeof id !== "string" || !id.trim()) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "Provide a PostgreSQL client and a provisioned witness ID.");
  }
  const query = client.query.bind(client);
  return Object.freeze({
    id,
    async reserve(operationId: string, fingerprint: string) {
      const { rowCount } = await query(RESERVE, [id, operationId, fingerprint]);
      if (rowCount === 0 || rowCount === 1) return rowCount === 1;
      throw new LocalProtectionError("STATE_UNAVAILABLE", "The PostgreSQL authority returned an invalid admission result.");
    },
  });
}
