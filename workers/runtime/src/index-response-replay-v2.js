import runtime, { Q18Truth as BaseQ18Truth } from './index.js';
import {
  HttpResponseReplayV2Store,
  validateHttpResponseReplayV2ForPersistence,
} from './http-response-replay-v2-persistence.mjs';

const MAX_PENDING_REPLAY_V2 = 128;

function operationKey(operationId) {
  return String(operationId || '').trim();
}

/**
 * Additive response-replay v2 bridge.
 *
 * The base runtime remains authoritative for execution, v1 replay, confirmation,
 * UNKNOWN handling, reconciliation, provider authorization, and all existing
 * customer-visible behavior. This subclass only observes an optional
 * `http_response.replay_v2` provider receipt and persists it beside the v1
 * receipt when the base runtime performs its existing replay commit.
 */
export class Q18Truth extends BaseQ18Truth {
  constructor(ctx, env) {
    super(ctx, env);
    this.httpResponseReplayV2Store = new HttpResponseReplayV2Store(
      this.ctx.storage.sql,
    );
    this.pendingHttpResponseReplayV2 = new Map();
  }

  async executeProvider(providerName, operationId, action = {}) {
    const key = operationKey(operationId);
    if (key) this.pendingHttpResponseReplayV2.delete(key);

    const provider = await super.executeProvider(
      providerName,
      operationId,
      action,
    );

    const candidate = provider?.http_response?.replay_v2;
    if (key && candidate !== undefined) {
      try {
        const validated = validateHttpResponseReplayV2ForPersistence(candidate);

        if (
          !this.pendingHttpResponseReplayV2.has(key) &&
          this.pendingHttpResponseReplayV2.size >= MAX_PENDING_REPLAY_V2
        ) {
          const oldest = this.pendingHttpResponseReplayV2.keys().next().value;
          if (oldest !== undefined) this.pendingHttpResponseReplayV2.delete(oldest);
        }

        this.pendingHttpResponseReplayV2.set(key, validated);
      }
      catch {
        // v2 is not authoritative for any currently eligible source shape.
        // Invalid optional metadata therefore cannot alter established v1
        // confirmation semantics. Absence of a durable v2 row keeps native
        // Response capability unavailable and fail-closed in later slices.
      }
    }

    return provider;
  }

  recordHttpResponseReplay(operationId, options = {}) {
    const key = operationKey(operationId);

    try {
      // Preserve the existing v1 write and all of its validation/conflict
      // behavior exactly. The base runtime invokes this method inside the same
      // transaction that transitions replay-required execution to CONFIRMED.
      const replayV1 = super.recordHttpResponseReplay(operationId, options);
      const replayV2 = key
        ? this.pendingHttpResponseReplayV2.get(key)
        : undefined;

      if (replayV2) {
        this.httpResponseReplayV2Store.record(
          key,
          replayV2,
          { recordedAt: options.recordedAt },
        );
      }

      return replayV1;
    }
    finally {
      if (key) this.pendingHttpResponseReplayV2.delete(key);
    }
  }

  getHttpResponseReplayV2(operationId) {
    return this.httpResponseReplayV2Store.get(operationId);
  }
}

export default runtime;
