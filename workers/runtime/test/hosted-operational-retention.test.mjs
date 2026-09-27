import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeHostedAdmissionPolicy } from '../src/hosted-admission-policy.mjs';
import { RuntimeHostedOperationalRetention } from '../src/hosted-operational-retention.mjs';
import { storage } from './harness.mjs';

function createContext(store) {
  return { storage: store };
}

function insertRateRow(store, tenantId, timestampMs, count = 1) {
  const windowKey = Math.floor(timestampMs / 60_000);
  store.sql.exec(
    `
      INSERT INTO hosted_execute_rate_limits (
        tenant_id, window_key, request_count, updated_at
      ) VALUES (?, ?, ?, ?)
    `,
    tenantId,
    windowKey,
    count,
    new Date(timestampMs).toISOString(),
  );
}

function insertAuditRow(store, tenantId, createdAt, eventType = 'TEST_EVENT') {
  store.sql.exec(
    `
      INSERT INTO hosted_admission_audit_events (
        tenant_id, operation_fingerprint, event_type, protection, plan,
        rate_limit, rate_remaining, usage_limit, usage_used, usage_period,
        created_at
      ) VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)
    `,
    tenantId,
    eventType,
    new Date(createdAt).toISOString(),
  );
}

test('retention deletes only operational rate/audit rows older than explicit cutoffs', async () => {
  const store = storage();
  try {
    new RuntimeHostedAdmissionPolicy({ ctx: createContext(store) });
    const retention = new RuntimeHostedOperationalRetention({ ctx: createContext(store) });

    const cutoff = Date.parse('2026-09-27T00:30:00.000Z');
    insertRateRow(store, 'tenant_a', Date.parse('2026-09-27T00:10:00.000Z'));
    insertRateRow(store, 'tenant_a', Date.parse('2026-09-27T00:29:00.000Z'));
    insertRateRow(store, 'tenant_a', Date.parse('2026-09-27T00:30:00.000Z'));
    insertRateRow(store, 'tenant_a', Date.parse('2026-09-27T00:31:00.000Z'));

    insertAuditRow(store, 'tenant_a', Date.parse('2026-09-27T00:10:00.000Z'));
    insertAuditRow(store, 'tenant_a', Date.parse('2026-09-27T00:29:59.999Z'));
    insertAuditRow(store, 'tenant_a', cutoff);
    insertAuditRow(store, 'tenant_a', Date.parse('2026-09-27T00:31:00.000Z'));

    const result = await retention.cleanup({
      rateLimitBeforeMs: cutoff,
      auditBeforeMs: cutoff,
      maxRowsPerTable: 100,
    });

    assert.equal(result.rateLimitRowsDeleted, 2);
    assert.equal(result.auditRowsDeleted, 2);
    assert.equal(result.rateLimitMayHaveMore, false);
    assert.equal(result.auditMayHaveMore, false);

    assert.equal(
      Number(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_execute_rate_limits')[0].n),
      2,
    );
    assert.equal(
      Number(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_admission_audit_events')[0].n),
      2,
    );

    const remainingRateWindows = store.sql.exec(`
      SELECT window_key
      FROM hosted_execute_rate_limits
      ORDER BY window_key
    `).map((row) => Number(row.window_key));
    assert.deepEqual(remainingRateWindows, [
      Math.floor(cutoff / 60_000),
      Math.floor(Date.parse('2026-09-27T00:31:00.000Z') / 60_000),
    ]);

    const remainingAuditTimes = store.sql.exec(`
      SELECT created_at
      FROM hosted_admission_audit_events
      ORDER BY created_at
    `).map((row) => String(row.created_at));
    assert.deepEqual(remainingAuditTimes, [
      new Date(cutoff).toISOString(),
      new Date(Date.parse('2026-09-27T00:31:00.000Z')).toISOString(),
    ]);
  } finally {
    store.db.close();
  }
});

test('retention cleanup is bounded and reports when another batch may remain', async () => {
  const store = storage();
  try {
    new RuntimeHostedAdmissionPolicy({ ctx: createContext(store) });
    const retention = new RuntimeHostedOperationalRetention({ ctx: createContext(store) });
    const cutoff = Date.parse('2026-09-27T01:00:00.000Z');

    for (let i = 0; i < 3; i += 1) {
      insertRateRow(store, `tenant_rate_${i}`, Date.parse(`2026-09-27T00:0${i}:00.000Z`));
      insertAuditRow(store, `tenant_audit_${i}`, Date.parse(`2026-09-27T00:0${i}:00.000Z`));
    }

    const first = await retention.cleanup({
      rateLimitBeforeMs: cutoff,
      auditBeforeMs: cutoff,
      maxRowsPerTable: 2,
    });
    assert.deepEqual(first, {
      rateLimitRowsDeleted: 2,
      auditRowsDeleted: 2,
      rateLimitMayHaveMore: true,
      auditMayHaveMore: true,
      maxRowsPerTable: 2,
    });

    const second = await retention.cleanup({
      rateLimitBeforeMs: cutoff,
      auditBeforeMs: cutoff,
      maxRowsPerTable: 2,
    });
    assert.equal(second.rateLimitRowsDeleted, 1);
    assert.equal(second.auditRowsDeleted, 1);
    assert.equal(second.rateLimitMayHaveMore, false);
    assert.equal(second.auditMayHaveMore, false);

    const third = await retention.cleanup({
      rateLimitBeforeMs: cutoff,
      auditBeforeMs: cutoff,
      maxRowsPerTable: 2,
    });
    assert.equal(third.rateLimitRowsDeleted, 0);
    assert.equal(third.auditRowsDeleted, 0);
  } finally {
    store.db.close();
  }
});

test('retention never deletes billing or safety authority tables', async () => {
  const store = storage();
  try {
    new RuntimeHostedAdmissionPolicy({ ctx: createContext(store) });
    const retention = new RuntimeHostedOperationalRetention({ ctx: createContext(store) });

    store.sql.exec(
      `
        INSERT INTO hosted_metered_operations (
          tenant_id, operation_id, effect_hash, first_period_key, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
      'tenant_authority',
      'op_authority',
      'sha256:fixture',
      '2026-09',
      '2026-09-01T00:00:00.000Z',
    );
    insertRateRow(store, 'tenant_authority', Date.parse('2026-09-01T00:00:00.000Z'));
    insertAuditRow(store, 'tenant_authority', Date.parse('2026-09-01T00:00:00.000Z'));

    assert.equal(
      Number(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n),
      1,
    );
    assert.equal(
      Number(store.sql.exec('SELECT used FROM hosted_usage_monthly WHERE tenant_id = ?', 'tenant_authority')[0].used),
      1,
    );

    await retention.cleanup({
      rateLimitBeforeMs: Date.parse('2026-09-27T00:00:00.000Z'),
      auditBeforeMs: Date.parse('2026-09-27T00:00:00.000Z'),
    });

    assert.equal(
      Number(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n),
      1,
      'logical-operation meter identity is authoritative and must not be pruned here',
    );
    assert.equal(
      Number(store.sql.exec('SELECT used FROM hosted_usage_monthly WHERE tenant_id = ?', 'tenant_authority')[0].used),
      1,
      'monthly usage authority must not be pruned by operational cleanup',
    );
    assert.equal(
      Number(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_execute_rate_limits')[0].n),
      0,
    );
    assert.equal(
      Number(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_admission_audit_events')[0].n),
      0,
    );
  } finally {
    store.db.close();
  }
});

test('retention has no implicit destructive default and rejects unsafe cleanup bounds', async () => {
  const store = storage();
  try {
    new RuntimeHostedAdmissionPolicy({ ctx: createContext(store) });
    const retention = new RuntimeHostedOperationalRetention({ ctx: createContext(store) });
    insertRateRow(store, 'tenant_guard', Date.parse('2026-09-01T00:00:00.000Z'));
    insertAuditRow(store, 'tenant_guard', Date.parse('2026-09-01T00:00:00.000Z'));

    await assert.rejects(
      retention.cleanup(),
      /at least one explicit retention cutoff is required/,
    );
    await assert.rejects(
      retention.cleanup({ rateLimitBeforeMs: -1 }),
      /rateLimitBeforeMs/,
    );
    await assert.rejects(
      retention.cleanup({ auditBeforeMs: Date.now(), maxRowsPerTable: 0 }),
      /maxRowsPerTable/,
    );
    await assert.rejects(
      retention.cleanup({ auditBeforeMs: Date.now(), maxRowsPerTable: 10001 }),
      /maxRowsPerTable/,
    );

    assert.equal(
      Number(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_execute_rate_limits')[0].n),
      1,
    );
    assert.equal(
      Number(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_admission_audit_events')[0].n),
      1,
    );
  } finally {
    store.db.close();
  }
});
