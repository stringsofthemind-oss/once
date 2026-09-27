import { HostedGatewayError } from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedAdmissionPolicy } from './hosted-admission-policy.mjs';

export const HOSTED_ENTITLEMENT_FRESHNESS_ENABLE_VALUE = 'phase12d';

const ACTIVE_ENTITLEMENT_STATUSES = new Set(['active', 'trialing']);
const MAX_ALLOWED_SECONDS = 365 * 24 * 60 * 60;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

function sqlRows(sql, query, ...params) {
  return [...sql.exec(query, ...params)];
}

function parseRequiredPositiveSeconds(value, name) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    throw new TypeError(`${name} must be a positive integer number of seconds`);
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_ALLOWED_SECONDS) {
    throw new TypeError(`${name} must be between 1 and ${MAX_ALLOWED_SECONDS} seconds`);
  }
  return seconds;
}

function parseOptionalNonNegativeSeconds(value, name, fallback = 0) {
  const raw = String(value ?? '').trim();
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new TypeError(`${name} must be a non-negative integer number of seconds`);
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_ALLOWED_SECONDS) {
    throw new TypeError(`${name} must be between 0 and ${MAX_ALLOWED_SECONDS} seconds`);
  }
  return seconds;
}

function parseTimestampMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Production-readiness freshness guard for hosted entitlement state.
 *
 * This wrapper is deliberately inactive unless the exact Phase 12D freshness
 * gate is configured. It does not replace the base entitlement policy; it adds
 * a fail-closed control-plane freshness check immediately before a new provider
 * attempt and again before logical-operation reservation/provider crossing.
 *
 * Safe replay and UNKNOWN reconciliation remain governed by the hosted core and
 * therefore continue to run before this guard is reached.
 */
export class RuntimeHostedEntitlementFreshnessPolicy {
  constructor({
    basePolicy,
    ctx,
    maxAgeSeconds,
    periodEndGraceSeconds = 0,
    clock = () => Date.now(),
  }) {
    if (!basePolicy) throw new TypeError('basePolicy is required');
    if (!ctx?.storage?.sql?.exec) throw new TypeError('ctx.storage.sql.exec is required');
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
      throw new TypeError('maxAgeSeconds must be a positive integer');
    }
    if (!Number.isSafeInteger(periodEndGraceSeconds) || periodEndGraceSeconds < 0) {
      throw new TypeError('periodEndGraceSeconds must be a non-negative integer');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');

    this.basePolicy = basePolicy;
    this.sql = ctx.storage.sql;
    this.maxAgeMs = maxAgeSeconds * 1000;
    this.periodEndGraceMs = periodEndGraceSeconds * 1000;
    this.clock = clock;
  }

  getEntitlementState(tenantId) {
    return sqlRows(
      this.sql,
      `
        SELECT status, updated_at, current_period_end
        FROM stripe_entitlements
        WHERE customer_id = ?
        LIMIT 1
      `,
      tenantId,
    )[0] ?? null;
  }

  entitlementFreshness(tenantId) {
    const entitlement = this.getEntitlementState(tenantId);
    if (!entitlement) return { applies: false, fresh: true };

    const status = String(entitlement.status || '').trim().toLowerCase();
    if (!ACTIVE_ENTITLEMENT_STATUSES.has(status)) {
      // Preserve the base policy's more specific inactive-entitlement result.
      return { applies: false, fresh: true };
    }

    const nowMs = Number(this.clock());
    if (!Number.isFinite(nowMs)) {
      throw new HostedGatewayError('entitlement_freshness_clock_invalid', 500);
    }

    const updatedAtMs = parseTimestampMs(entitlement.updated_at);
    const periodEndMs = parseTimestampMs(entitlement.current_period_end);
    if (updatedAtMs === null || periodEndMs === null) {
      return { applies: true, fresh: false, reason: 'missing_or_invalid_timestamp' };
    }

    if (updatedAtMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS) {
      return { applies: true, fresh: false, reason: 'updated_at_in_future' };
    }

    if (nowMs - updatedAtMs > this.maxAgeMs) {
      return { applies: true, fresh: false, reason: 'update_too_old' };
    }

    if (nowMs > periodEndMs + this.periodEndGraceMs) {
      return { applies: true, fresh: false, reason: 'period_end_expired' };
    }

    return { applies: true, fresh: true };
  }

  assertFreshForNewProviderAttempt(tenantId) {
    const freshness = this.entitlementFreshness(tenantId);
    if (freshness.applies && !freshness.fresh) {
      // Do not expose internal timestamps or lifecycle detail to the caller.
      throw new HostedGatewayError('entitlement_state_stale', 503);
    }
  }

  async authorizeRequest(context) {
    return this.basePolicy.authorizeRequest(context);
  }

  async authorizeProviderAttempt(context) {
    this.assertFreshForNewProviderAttempt(context?.tenantId);
    return this.basePolicy.authorizeProviderAttempt(context);
  }

  async reserveProtectedOperation(context) {
    this.assertFreshForNewProviderAttempt(context?.tenantId);
    return this.basePolicy.reserveProtectedOperation(context);
  }
}

/**
 * Factory used by the runtime wiring.
 *
 * With the freshness gate absent, this returns the existing Phase 12D policy
 * unchanged. Enabling freshness requires an explicit max-age value; malformed
 * configuration fails closed during policy construction.
 */
export function createRuntimeHostedAdmissionPolicy({
  ctx,
  env = {},
  clock = () => Date.now(),
  requestLimitPerMinute,
  planLimits,
} = {}) {
  const basePolicy = new RuntimeHostedAdmissionPolicy({
    ctx,
    clock,
    ...(requestLimitPerMinute === undefined ? {} : { requestLimitPerMinute }),
    ...(planLimits === undefined ? {} : { planLimits }),
  });

  if (
    String(env?.ONCE_HOSTED_ENTITLEMENT_FRESHNESS_ENABLED || '') !==
    HOSTED_ENTITLEMENT_FRESHNESS_ENABLE_VALUE
  ) {
    return basePolicy;
  }

  const maxAgeSeconds = parseRequiredPositiveSeconds(
    env.ONCE_HOSTED_ENTITLEMENT_MAX_AGE_SECONDS,
    'ONCE_HOSTED_ENTITLEMENT_MAX_AGE_SECONDS',
  );
  const periodEndGraceSeconds = parseOptionalNonNegativeSeconds(
    env.ONCE_HOSTED_ENTITLEMENT_PERIOD_END_GRACE_SECONDS,
    'ONCE_HOSTED_ENTITLEMENT_PERIOD_END_GRACE_SECONDS',
    0,
  );

  return new RuntimeHostedEntitlementFreshnessPolicy({
    basePolicy,
    ctx,
    maxAgeSeconds,
    periodEndGraceSeconds,
    clock,
  });
}
