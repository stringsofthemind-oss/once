import {
  HostedGatewayError,
  sha256Hex,
} from '../../gateway/src/hosted-gateway-core.js';
import {
  LEGACY_HOSTED_PLAN_LIMITS,
  resolveHostedStripePlan,
} from './hosted-plan-catalog.mjs';

export const DEFAULT_HOSTED_PLAN_LIMITS = LEGACY_HOSTED_PLAN_LIMITS;

const ACTIVE_ENTITLEMENT_STATUSES = new Set(['active', 'trialing']);

function sqlRows(sql, query, ...params) {
  return [...sql.exec(query, ...params)];
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function utcPeriodKey(nowMs) {
  const date = new Date(nowMs);
  if (!Number.isFinite(date.getTime())) throw new TypeError('clock returned invalid time');
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function optionalInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function auditOperationFingerprint(tenantId, operationId) {
  if (typeof operationId !== 'string' || operationId.length === 0) return null;
  return `sha256:${await sha256Hex(`once-audit-v1\0${tenantId}\0${operationId}`)}`;
}

/**
 * Phase 12D hosted admission policy.
 *
 * Request-level admission applies infrastructure rate limiting and may return a
 * non-authoritative active-plan usage snapshot. It deliberately does not block
 * on entitlement lifecycle state: confirmed replay and UNKNOWN reconciliation
 * must remain available after an original attempt even if entitlement changes.
 *
 * Active entitlement is enforced by authorizeProviderAttempt only after the
 * core state machine determines a new provider attempt may be required, and
 * before adapter preflight. Logical-operation metering is a later reservation
 * invoked only after deterministic provider preflight, immediately before
 * durable UNKNOWN and the provider boundary.
 *
 * Metering identity is global across billing periods:
 *   one (tenant_id, operation_id) -> first authoritative effect_hash
 *
 * Operational audit rows are deliberately allowlisted scalar metadata. They do
 * not contain request payloads, raw operation IDs, authorization material,
 * provider credentials, provider results or free-form metadata. Operation
 * correlation uses a tenant-scoped one-way fingerprint. These rows are
 * observability records, not a replacement for authoritative meter tables.
 */
export class RuntimeHostedAdmissionPolicy {
  constructor({
    ctx,
    planLimits = DEFAULT_HOSTED_PLAN_LIMITS,
    requestLimitPerMinute = 120,
    clock = () => Date.now(),
  }) {
    if (!ctx?.storage?.sql?.exec) throw new TypeError('ctx.storage.sql.exec is required');
    if (typeof ctx.storage.sync !== 'function') throw new TypeError('ctx.storage.sync is required');
    if (!planLimits || typeof planLimits !== 'object' || Array.isArray(planLimits)) {
      throw new TypeError('planLimits must be an object');
    }
    if (!Number.isSafeInteger(requestLimitPerMinute) || requestLimitPerMinute < 1) {
      throw new TypeError('requestLimitPerMinute must be a positive integer');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');

    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.planLimits = Object.freeze({ ...planLimits });
    this.requestLimitPerMinute = requestLimitPerMinute;
    this.clock = clock;
    this.initialize();
  }

  initialize() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hosted_usage_monthly (
        tenant_id TEXT NOT NULL,
        period_key TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, period_key)
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hosted_metered_operations (
        tenant_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        effect_hash TEXT NOT NULL,
        first_period_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, operation_id)
      )
    `);

    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS hosted_metered_operations_usage_insert
      AFTER INSERT ON hosted_metered_operations
      BEGIN
        INSERT INTO hosted_usage_monthly (
          tenant_id, period_key, used, updated_at
        ) VALUES (
          NEW.tenant_id, NEW.first_period_key, 1, NEW.created_at
        )
        ON CONFLICT(tenant_id, period_key) DO UPDATE SET
          used = hosted_usage_monthly.used + 1,
          updated_at = excluded.updated_at;
      END
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hosted_execute_rate_limits (
        tenant_id TEXT NOT NULL,
        window_key INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, window_key)
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hosted_admission_audit_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        operation_fingerprint TEXT,
        event_type TEXT NOT NULL,
        protection TEXT,
        plan TEXT,
        rate_limit INTEGER,
        rate_remaining INTEGER,
        usage_limit INTEGER,
        usage_used INTEGER,
        usage_period TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_hosted_admission_audit_tenant_event
      ON hosted_admission_audit_events (tenant_id, event_id)
    `);
  }

  async recordAuditEvent({
    tenantId,
    operationId = null,
    eventType,
    protection = null,
    plan = null,
    rate = null,
    usage = null,
    nowMs,
  }) {
    requireString(tenantId, 'tenantId');
    requireString(eventType, 'eventType');
    const createdAt = new Date(nowMs).toISOString();
    const operationFingerprint = await auditOperationFingerprint(tenantId, operationId);

    this.sql.exec(
      `
        INSERT INTO hosted_admission_audit_events (
          tenant_id,
          operation_fingerprint,
          event_type,
          protection,
          plan,
          rate_limit,
          rate_remaining,
          usage_limit,
          usage_used,
          usage_period,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      tenantId,
      operationFingerprint,
      eventType,
      typeof protection === 'string' && protection ? protection : null,
      typeof plan === 'string' && plan ? plan : null,
      optionalInteger(rate?.limit),
      optionalInteger(rate?.remaining),
      optionalInteger(usage?.limit),
      optionalInteger(usage?.used),
      typeof usage?.period === 'string' && usage.period ? usage.period : null,
      createdAt,
    );
  }

  getEntitlement(tenantId) {
    return sqlRows(
      this.sql,
      `
        SELECT plan, status, price_id, current_period_end
        FROM stripe_entitlements
        WHERE customer_id = ?
        LIMIT 1
      `,
      tenantId,
    )[0] ?? null;
  }

  getAuthoritativePlan(entitlement) {
    return resolveHostedStripePlan({
      priceId: entitlement?.price_id,
      metadataPlan: entitlement?.plan,
    }).plan;
  }

  getMeteredOperation(tenantId, operationId) {
    return sqlRows(
      this.sql,
      `
        SELECT effect_hash, first_period_key, created_at
        FROM hosted_metered_operations
        WHERE tenant_id = ? AND operation_id = ?
        LIMIT 1
      `,
      tenantId,
      operationId,
    )[0] ?? null;
  }

  getMonthlyUsage(tenantId, periodKey) {
    const row = sqlRows(
      this.sql,
      `
        SELECT used
        FROM hosted_usage_monthly
        WHERE tenant_id = ? AND period_key = ?
        LIMIT 1
      `,
      tenantId,
      periodKey,
    )[0];
    return Number(row?.used ?? 0);
  }

  getActivePlan(tenantId) {
    const entitlement = this.getEntitlement(tenantId);
    if (!entitlement) throw new HostedGatewayError('entitlement_required', 403);

    const status = String(entitlement.status || '').trim().toLowerCase();
    if (!ACTIVE_ENTITLEMENT_STATUSES.has(status)) {
      throw new HostedGatewayError('entitlement_inactive', 403);
    }

    const plan = this.getAuthoritativePlan(entitlement);
    const monthlyLimit = Number(this.planLimits[plan]);
    if (!Number.isSafeInteger(monthlyLimit) || monthlyLimit < 1) {
      throw new HostedGatewayError('entitlement_plan_unsupported', 403);
    }
    return { plan, monthlyLimit };
  }

  getOptionalActivePlan(tenantId) {
    const entitlement = this.getEntitlement(tenantId);
    if (!entitlement) return null;
    const status = String(entitlement.status || '').trim().toLowerCase();
    if (!ACTIVE_ENTITLEMENT_STATUSES.has(status)) return null;
    const plan = this.getAuthoritativePlan(entitlement);
    const monthlyLimit = Number(this.planLimits[plan]);
    if (!Number.isSafeInteger(monthlyLimit) || monthlyLimit < 1) return null;
    return { plan, monthlyLimit };
  }

  applyRateLimit(tenantId, nowMs) {
    const windowKey = Math.floor(nowMs / 60_000);
    const nowIso = new Date(nowMs).toISOString();
    const row = sqlRows(
      this.sql,
      `
        SELECT request_count
        FROM hosted_execute_rate_limits
        WHERE tenant_id = ? AND window_key = ?
        LIMIT 1
      `,
      tenantId,
      windowKey,
    )[0];
    const current = Number(row?.request_count ?? 0);
    if (!Number.isSafeInteger(current) || current < 0) {
      throw new HostedGatewayError('rate_limit_state_invalid', 500);
    }
    if (current >= this.requestLimitPerMinute) {
      throw new HostedGatewayError('rate_limit_exceeded', 429);
    }

    this.sql.exec(
      `
        INSERT INTO hosted_execute_rate_limits (
          tenant_id, window_key, request_count, updated_at
        ) VALUES (?, ?, 1, ?)
        ON CONFLICT(tenant_id, window_key) DO UPDATE SET
          request_count = hosted_execute_rate_limits.request_count + 1,
          updated_at = excluded.updated_at
      `,
      tenantId,
      windowKey,
      nowIso,
    );

    return {
      limit: this.requestLimitPerMinute,
      remaining: Math.max(0, this.requestLimitPerMinute - current - 1),
      windowKey,
    };
  }

  async authorizeRequest({ tenantId, operationId = null, protection }) {
    requireString(tenantId, 'tenantId');

    const nowMs = Number(this.clock());
    if (!Number.isFinite(nowMs)) throw new HostedGatewayError('admission_clock_invalid', 500);
    const rate = this.applyRateLimit(tenantId, nowMs);

    if (protection === 'BYPASS') {
      const result = {
        protection: 'BYPASS',
        rate,
      };
      await this.recordAuditEvent({
        tenantId,
        operationId,
        eventType: 'REQUEST_ADMITTED',
        protection: 'BYPASS',
        rate,
        nowMs,
      });
      return result;
    }

    const active = this.getOptionalActivePlan(tenantId);
    const result = {
      protection: 'PROTECT',
      rate,
    };
    if (active) {
      const period = utcPeriodKey(nowMs);
      const usage = {
        limit: active.monthlyLimit,
        used: this.getMonthlyUsage(tenantId, period),
        period,
      };
      Object.assign(result, {
        plan: active.plan,
        limit: active.monthlyLimit,
        usage,
      });
    }

    await this.recordAuditEvent({
      tenantId,
      operationId,
      eventType: 'REQUEST_ADMITTED',
      protection: 'PROTECT',
      plan: result.plan ?? null,
      rate,
      usage: result.usage ?? null,
      nowMs,
    });
    return result;
  }

  async authorizeProviderAttempt({ tenantId, operationId = null }) {
    requireString(tenantId, 'tenantId');

    const nowMs = Number(this.clock());
    if (!Number.isFinite(nowMs)) throw new HostedGatewayError('admission_clock_invalid', 500);
    const { plan, monthlyLimit } = this.getActivePlan(tenantId);
    const period = utcPeriodKey(nowMs);
    const usage = {
      limit: monthlyLimit,
      used: this.getMonthlyUsage(tenantId, period),
      period,
    };
    const result = {
      protection: 'PROTECT',
      plan,
      limit: monthlyLimit,
      usage,
    };
    await this.recordAuditEvent({
      tenantId,
      operationId,
      eventType: 'PROVIDER_ATTEMPT_ADMITTED',
      protection: 'PROTECT',
      plan,
      usage,
      nowMs,
    });
    return result;
  }

  async reserveProtectedOperation({ tenantId, operationId, effectHash }) {
    requireString(tenantId, 'tenantId');
    requireString(operationId, 'operationId');
    requireString(effectHash, 'effectHash');

    const nowMs = Number(this.clock());
    if (!Number.isFinite(nowMs)) throw new HostedGatewayError('admission_clock_invalid', 500);

    // Re-read entitlement at the final provider-attempt boundary. If a
    // subscription changes during deterministic preflight, execution still
    // fails closed rather than crossing under stale authorization.
    const { plan, monthlyLimit } = this.getActivePlan(tenantId);

    const existing = this.getMeteredOperation(tenantId, operationId);
    if (existing) {
      if (String(existing.effect_hash) !== effectHash) {
        throw new HostedGatewayError('operation_effect_conflict', 409);
      }
      const firstPeriod = String(existing.first_period_key);
      const result = {
        metered: false,
        replay: true,
        plan,
        limit: monthlyLimit,
        used: this.getMonthlyUsage(tenantId, firstPeriod),
        period: firstPeriod,
      };
      await this.recordAuditEvent({
        tenantId,
        operationId,
        eventType: 'METER_REUSED',
        protection: 'PROTECT',
        plan,
        usage: { limit: monthlyLimit, used: result.used, period: firstPeriod },
        nowMs,
      });
      return result;
    }

    const periodKey = utcPeriodKey(nowMs);
    const used = this.getMonthlyUsage(tenantId, periodKey);
    if (!Number.isSafeInteger(used) || used < 0) {
      throw new HostedGatewayError('usage_state_invalid', 500);
    }
    if (used >= monthlyLimit) {
      throw new HostedGatewayError('monthly_limit_exceeded', 429);
    }

    const nowIso = new Date(nowMs).toISOString();
    this.sql.exec(
      `
        INSERT OR IGNORE INTO hosted_metered_operations (
          tenant_id, operation_id, effect_hash, first_period_key, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
      tenantId,
      operationId,
      effectHash,
      periodKey,
      nowIso,
    );

    const inserted = Number(
      sqlRows(this.sql, 'SELECT changes() AS changes')[0]?.changes ?? 0,
    ) === 1;

    if (!inserted) {
      const raced = this.getMeteredOperation(tenantId, operationId);
      if (!raced) throw new HostedGatewayError('usage_reservation_failed', 500);
      if (String(raced.effect_hash) !== effectHash) {
        throw new HostedGatewayError('operation_effect_conflict', 409);
      }
      const firstPeriod = String(raced.first_period_key);
      const result = {
        metered: false,
        replay: true,
        plan,
        limit: monthlyLimit,
        used: this.getMonthlyUsage(tenantId, firstPeriod),
        period: firstPeriod,
      };
      await this.recordAuditEvent({
        tenantId,
        operationId,
        eventType: 'METER_REUSED',
        protection: 'PROTECT',
        plan,
        usage: { limit: monthlyLimit, used: result.used, period: firstPeriod },
        nowMs,
      });
      return result;
    }

    // A newly accepted logical-operation reservation is a provider-crossing
    // prerequisite. Flush it before GatewayCore may write UNKNOWN or execute.
    await this.storage.sync();

    const result = {
      metered: true,
      replay: false,
      plan,
      limit: monthlyLimit,
      used: this.getMonthlyUsage(tenantId, periodKey),
      period: periodKey,
    };
    await this.recordAuditEvent({
      tenantId,
      operationId,
      eventType: 'METER_RESERVED',
      protection: 'PROTECT',
      plan,
      usage: { limit: monthlyLimit, used: result.used, period: periodKey },
      nowMs,
    });
    return result;
  }
}
