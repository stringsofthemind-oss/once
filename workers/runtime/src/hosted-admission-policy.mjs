import { HostedGatewayError } from '../../gateway/src/hosted-gateway-core.js';

export const DEFAULT_HOSTED_PLAN_LIMITS = Object.freeze({
  pro: 100_000,
  startup: 500_000,
  scale: 2_000_000,
});

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

/**
 * Phase 12D hosted admission policy.
 *
 * This policy is intentionally runtime-local and is NOT wired into the public
 * production execute route by this module alone. It is designed to be injected
 * into HostedGatewayCore before production cutover.
 *
 * Ordering invariant:
 *   authenticate -> target/schema/binding -> authorize here -> provider boundary
 *
 * Metering invariant:
 *   one (tenant_id, operation_id) is reserved once globally, with the first
 *   authoritative effect_hash permanently bound to it. Retries/replays in later
 *   calendar months therefore do not create another billable logical operation.
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
      CREATE TABLE IF NOT EXISTS hosted_usage_monthly (
        tenant_id TEXT NOT NULL,
        period_key TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, period_key)
      )
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
  }

  getEntitlement(tenantId) {
    return sqlRows(
      this.sql,
      `
        SELECT plan, status, current_period_end
        FROM stripe_entitlements
        WHERE customer_id = ?
        LIMIT 1
      `,
      tenantId,
    )[0] ?? null;
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

  async authorize({
    tenantId,
    operationId,
    effectHash,
    protection,
  }) {
    requireString(tenantId, 'tenantId');
    requireString(operationId, 'operationId');
    requireString(effectHash, 'effectHash');

    const nowMs = Number(this.clock());
    if (!Number.isFinite(nowMs)) throw new HostedGatewayError('admission_clock_invalid', 500);

    const rate = this.applyRateLimit(tenantId, nowMs);

    if (protection === 'BYPASS') {
      return {
        protection: 'BYPASS',
        metered: false,
        rate,
      };
    }

    const entitlement = this.getEntitlement(tenantId);
    if (!entitlement) throw new HostedGatewayError('entitlement_required', 403);

    const status = String(entitlement.status || '').trim().toLowerCase();
    if (!ACTIVE_ENTITLEMENT_STATUSES.has(status)) {
      throw new HostedGatewayError('entitlement_inactive', 403);
    }

    const plan = String(entitlement.plan || '').trim().toLowerCase();
    const monthlyLimit = Number(this.planLimits[plan]);
    if (!Number.isSafeInteger(monthlyLimit) || monthlyLimit < 1) {
      throw new HostedGatewayError('entitlement_plan_unsupported', 403);
    }

    const existing = this.getMeteredOperation(tenantId, operationId);
    if (existing) {
      if (String(existing.effect_hash) !== effectHash) {
        throw new HostedGatewayError('operation_effect_conflict', 409);
      }
      const firstPeriod = String(existing.first_period_key);
      return {
        protection: 'PROTECT',
        metered: false,
        replay: true,
        plan,
        limit: monthlyLimit,
        used: this.getMonthlyUsage(tenantId, firstPeriod),
        period: firstPeriod,
        rate,
      };
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
        INSERT INTO hosted_metered_operations (
          tenant_id, operation_id, effect_hash, first_period_key, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
      tenantId,
      operationId,
      effectHash,
      periodKey,
      nowIso,
    );

    this.sql.exec(
      `
        INSERT INTO hosted_usage_monthly (
          tenant_id, period_key, used, updated_at
        ) VALUES (?, ?, 1, ?)
        ON CONFLICT(tenant_id, period_key) DO UPDATE SET
          used = hosted_usage_monthly.used + 1,
          updated_at = excluded.updated_at
      `,
      tenantId,
      periodKey,
      nowIso,
    );

    // The usage reservation is a provider-crossing prerequisite. It must be
    // durable before execution can continue, just like the UNKNOWN boundary.
    await this.storage.sync();

    return {
      protection: 'PROTECT',
      metered: true,
      replay: false,
      plan,
      limit: monthlyLimit,
      used: used + 1,
      period: periodKey,
      rate,
    };
  }
}
