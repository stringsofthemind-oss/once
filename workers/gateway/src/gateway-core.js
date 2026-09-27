export const GatewayDecision = Object.freeze({
  BYPASS: 'BYPASS',
  EXECUTE: 'EXECUTE',
  REPLAY_CONFIRMED: 'REPLAY_CONFIRMED',
  BLOCK_UNKNOWN: 'BLOCK_UNKNOWN',
  BLOCK_CONFLICT_SCOPE: 'BLOCK_CONFLICT_SCOPE',
  CONFLICT: 'CONFLICT',
});

export const OutcomeState = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  UNKNOWN: 'UNKNOWN',
});

export class AmbiguousOutcomeError extends Error {
  constructor(message = 'provider outcome is ambiguous') {
    super(message);
    this.name = 'AmbiguousOutcomeError';
  }
}

export class MemoryOperationStore {
  constructor() {
    this.records = new Map();
    this.queues = new Map();
  }

  async withLock(operationId, fn) {
    const previous = this.queues.get(operationId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.queues.set(operationId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.queues.get(operationId) === tail) this.queues.delete(operationId);
    }
  }

  async get(operationId) {
    return this.records.get(operationId) ?? null;
  }

  async put(operationId, record) {
    this.records.set(operationId, structuredClone(record));
  }

  async findUnknownByConflictKey(conflictKey, excludeOperationId = null) {
    if (!conflictKey) return null;
    for (const record of this.records.values()) {
      if (
        record?.state === OutcomeState.UNKNOWN &&
        record?.conflictKey === conflictKey &&
        record?.operationId !== excludeOperationId
      ) {
        return structuredClone(record);
      }
    }
    return null;
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function normalizeReconciliation(result) {
  if (!result || typeof result !== 'object') return { status: 'UNKNOWN' };
  if (result.status === 'CONFIRMED') return result;
  if (result.status === 'ABSENT' && result.authoritative === true) return result;
  return { status: 'UNKNOWN' };
}

export class GatewayCore {
  constructor({
    store,
    clock = () => new Date().toISOString(),
    beforeProviderPreflight = null,
    beforeProviderAttempt = null,
  }) {
    if (!store?.withLock || !store?.get || !store?.put) {
      throw new TypeError('store must implement withLock/get/put');
    }
    if (beforeProviderPreflight !== null && typeof beforeProviderPreflight !== 'function') {
      throw new TypeError('beforeProviderPreflight must be a function');
    }
    if (beforeProviderAttempt !== null && typeof beforeProviderAttempt !== 'function') {
      throw new TypeError('beforeProviderAttempt must be a function');
    }
    this.store = store;
    this.clock = clock;
    this.beforeProviderPreflight = beforeProviderPreflight;
    this.beforeProviderAttempt = beforeProviderAttempt;
  }

  async execute(request, adapter) {
    const {
      operationId,
      effectHash,
      conflictKey = null,
      payload,
      protection = 'PROTECT',
      metadata = {},
    } = request ?? {};

    requireString(operationId, 'operationId');
    requireString(effectHash, 'effectHash');
    if (conflictKey !== null && conflictKey !== undefined) {
      requireString(conflictKey, 'conflictKey');
    }

    if (protection === 'BYPASS') {
      const result = await adapter.execute({ operationId, effectHash, conflictKey, payload, metadata });
      return { decision: GatewayDecision.BYPASS, result };
    }

    // When conflict fencing is requested, serialize the entire decision path on
    // the conflict scope rather than only the operation ID. This prevents two
    // different logical operations for the same external object from both
    // observing an unfenced scope and crossing the provider boundary.
    const lockKey = conflictKey ? `conflict:${conflictKey}` : `operation:${operationId}`;

    return this.store.withLock(lockKey, async () => {
      const existing = await this.store.get(operationId);

      if (existing && existing.effectHash !== effectHash) {
        return {
          decision: GatewayDecision.CONFLICT,
          state: existing.state,
          operationId,
        };
      }

      if (
        existing &&
        (existing.conflictKey ?? null) !== (conflictKey ?? null)
      ) {
        return {
          decision: GatewayDecision.CONFLICT,
          state: existing.state,
          operationId,
        };
      }

      if (existing?.state === OutcomeState.CONFIRMED) {
        return {
          decision: GatewayDecision.REPLAY_CONFIRMED,
          state: OutcomeState.CONFIRMED,
          operationId,
          result: existing.result,
        };
      }

      // A different unresolved logical operation on the same external scope is
      // a hard fence. A fresh operation ID, changed payload, new process, or new
      // tool-call identity must not escape the earlier UNKNOWN.
      if (conflictKey && typeof this.store.findUnknownByConflictKey === 'function') {
        const blocker = await this.store.findUnknownByConflictKey(conflictKey, operationId);
        if (blocker) {
          return {
            decision: GatewayDecision.BLOCK_CONFLICT_SCOPE,
            state: OutcomeState.UNKNOWN,
            operationId,
            conflictKey,
            blockingOperationId: blocker.operationId,
          };
        }
      }

      if (existing?.state === OutcomeState.UNKNOWN) {
        let reconciliation;
        try {
          reconciliation = normalizeReconciliation(
            await adapter.reconcile({ operationId, effectHash, conflictKey, payload, metadata, record: existing }),
          );
        } catch {
          return {
            decision: GatewayDecision.BLOCK_UNKNOWN,
            state: OutcomeState.UNKNOWN,
            operationId,
          };
        }

        if (reconciliation.status === 'CONFIRMED') {
          const record = {
            ...existing,
            state: OutcomeState.CONFIRMED,
            result: reconciliation.result,
            providerReference: reconciliation.providerReference ?? existing.providerReference ?? null,
            updatedAt: this.clock(),
          };
          await this.store.put(operationId, record);
          return {
            decision: GatewayDecision.REPLAY_CONFIRMED,
            state: OutcomeState.CONFIRMED,
            operationId,
            result: record.result,
          };
        }

        if (reconciliation.status !== 'ABSENT') {
          return {
            decision: GatewayDecision.BLOCK_UNKNOWN,
            state: OutcomeState.UNKNOWN,
            operationId,
          };
        }
      }

      // Commercial/provider-attempt authorization belongs after all safe local
      // replay/conflict/reconciliation exits. This lets an already-confirmed
      // operation replay, and lets an UNKNOWN operation reconcile, even if the
      // tenant's entitlement changed after the original attempt. If a new
      // provider attempt is actually required, authorization still fails closed
      // before adapter preflight or provider crossing.
      if (this.beforeProviderPreflight) {
        await this.beforeProviderPreflight({
          operationId,
          effectHash,
          conflictKey,
          payload,
          metadata,
          record: existing ?? null,
        });
      }

      if (typeof adapter.preflight === 'function') {
        await adapter.preflight({ operationId, effectHash, conflictKey, payload, metadata, record: existing ?? null });
      }

      if (this.beforeProviderAttempt) {
        await this.beforeProviderAttempt({
          operationId,
          effectHash,
          conflictKey,
          payload,
          metadata,
          record: existing ?? null,
        });
      }

      const startedAt = this.clock();
      await this.store.put(operationId, {
        operationId,
        effectHash,
        conflictKey,
        state: OutcomeState.UNKNOWN,
        result: null,
        providerReference: null,
        createdAt: existing?.createdAt ?? startedAt,
        updatedAt: startedAt,
      });

      try {
        const result = await adapter.execute({ operationId, effectHash, conflictKey, payload, metadata });
        const record = {
          operationId,
          effectHash,
          conflictKey,
          state: OutcomeState.CONFIRMED,
          result,
          providerReference: result?.providerReference ?? null,
          createdAt: existing?.createdAt ?? startedAt,
          updatedAt: this.clock(),
        };
        await this.store.put(operationId, record);
        return {
          decision: GatewayDecision.EXECUTE,
          state: OutcomeState.CONFIRMED,
          operationId,
          result,
        };
      } catch (error) {
        if (!(error instanceof AmbiguousOutcomeError)) throw error;
        return {
          decision: GatewayDecision.BLOCK_UNKNOWN,
          state: OutcomeState.UNKNOWN,
          operationId,
        };
      }
    });
  }
}
