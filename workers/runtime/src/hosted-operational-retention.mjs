const MAX_CLEANUP_BATCH = 10_000;

function sqlRows(sql, query, ...params) {
  return [...sql.exec(query, ...params)];
}

function requireCutoff(value, name) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new TypeError(`${name} must be a non-negative finite millisecond timestamp`);
  }
  const date = new Date(numeric);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${name} must be a valid millisecond timestamp`);
  }
  return numeric;
}

function requireBatchSize(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > MAX_CLEANUP_BATCH) {
    throw new TypeError(`maxRowsPerTable must be an integer between 1 and ${MAX_CLEANUP_BATCH}`);
  }
  return numeric;
}

/**
 * Bounded cleanup mechanism for hosted operational telemetry only.
 *
 * This deliberately has no scheduler, default retention duration or public
 * route. Production policy must supply explicit cutoffs. It is forbidden from
 * touching safety/billing authority such as hosted_gateway_operations,
 * hosted_metered_operations or hosted_usage_monthly.
 */
export class RuntimeHostedOperationalRetention {
  constructor({ ctx }) {
    if (!ctx?.storage?.sql?.exec) {
      throw new TypeError('ctx.storage.sql.exec is required');
    }
    if (typeof ctx.storage.transactionSync !== 'function') {
      throw new TypeError('ctx.storage.transactionSync is required');
    }
    if (typeof ctx.storage.sync !== 'function') {
      throw new TypeError('ctx.storage.sync is required');
    }

    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.initializeIndexes();
  }

  initializeIndexes() {
    // These tables are created by RuntimeHostedAdmissionPolicy. Retention is
    // intentionally constructed only after that policy exists.
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_hosted_execute_rate_limits_window
      ON hosted_execute_rate_limits (window_key)
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_hosted_admission_audit_created
      ON hosted_admission_audit_events (created_at, event_id)
    `);
  }

  async cleanup({
    rateLimitBeforeMs = null,
    auditBeforeMs = null,
    maxRowsPerTable = 1_000,
  } = {}) {
    const rateCutoff = requireCutoff(rateLimitBeforeMs, 'rateLimitBeforeMs');
    const auditCutoff = requireCutoff(auditBeforeMs, 'auditBeforeMs');
    const batchSize = requireBatchSize(maxRowsPerTable);

    if (rateCutoff === null && auditCutoff === null) {
      throw new TypeError('at least one explicit retention cutoff is required');
    }

    let rateLimitRowsDeleted = 0;
    let auditRowsDeleted = 0;

    this.storage.transactionSync(() => {
      if (rateCutoff !== null) {
        // A rate-limit row represents a complete one-minute window. Delete only
        // windows strictly before the minute containing the supplied cutoff.
        const cutoffWindow = Math.floor(rateCutoff / 60_000);
        this.sql.exec(
          `
            DELETE FROM hosted_execute_rate_limits
            WHERE rowid IN (
              SELECT rowid
              FROM hosted_execute_rate_limits
              WHERE window_key < ?
              ORDER BY window_key ASC, tenant_id ASC
              LIMIT ?
            )
          `,
          cutoffWindow,
          batchSize,
        );
        rateLimitRowsDeleted = Number(
          sqlRows(this.sql, 'SELECT changes() AS n')[0]?.n ?? 0,
        );
      }

      if (auditCutoff !== null) {
        const cutoffIso = new Date(auditCutoff).toISOString();
        this.sql.exec(
          `
            DELETE FROM hosted_admission_audit_events
            WHERE event_id IN (
              SELECT event_id
              FROM hosted_admission_audit_events
              WHERE created_at < ?
              ORDER BY created_at ASC, event_id ASC
              LIMIT ?
            )
          `,
          cutoffIso,
          batchSize,
        );
        auditRowsDeleted = Number(
          sqlRows(this.sql, 'SELECT changes() AS n')[0]?.n ?? 0,
        );
      }
    });

    if (rateLimitRowsDeleted > 0 || auditRowsDeleted > 0) {
      await this.storage.sync();
    }

    return {
      rateLimitRowsDeleted,
      auditRowsDeleted,
      rateLimitMayHaveMore: rateLimitRowsDeleted === batchSize,
      auditMayHaveMore: auditRowsDeleted === batchSize,
      maxRowsPerTable: batchSize,
    };
  }
}
