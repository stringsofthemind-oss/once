export const GatewayDecision = Object.freeze({
  BYPASS: 'BYPASS',
  EXECUTE: 'EXECUTE',
  REPLAY_CONFIRMED: 'REPLAY_CONFIRMED',
  BLOCK_UNKNOWN: 'BLOCK_UNKNOWN',
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
  constructor({ store, clock = () => new Date().toISOString() }) {
    if (!store?.withLock || !store?.get || !store?.put) {
      throw new TypeError('store must implement withLock/get/put');
    }
    this.store = store;
    this.clock = clock;
  }

  async execute(request, adapter) {
    const {
      operationId,
      effectHash,
      payload,
      protection = 'PROTECT',
      metadata = {},
    } = request ?? {};

    requireString(operationId, 'operationId');
    requireString(effectHash, 'effectHash');

    if (protection === 'BYPASS') {
      const result = await adapter.execute({ operationId, effectHash, payload, metadata });
      return { decision: GatewayDecision.BYPASS, result };
    }

    return this.store.withLock(operationId, async () => {
      const existing = await this.store.get(operationId);

      if (existing && existing.effectHash !== effectHash) {
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

      if (existing?.state === OutcomeState.UNKNOWN) {
        let reconciliation;
        try {
          reconciliation = normalizeReconciliation(
            await adapter.reconcile({ operationId, effectHash, payload, metadata, record: existing }),
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

      // Deterministic configuration/credential failures must happen before the
      // crash boundary is recorded. A successful preflight is not evidence that
      // a provider effect occurred; it only proves the adapter is ready to cross
      // the boundary. Confirmed replay returns above and never needs preflight.
      if (typeof adapter.preflight === 'function') {
        await adapter.preflight({ operationId, effectHash, payload, metadata, record: existing ?? null });
      }

      const startedAt = this.clock();
      await this.store.put(operationId, {
        operationId,
        effectHash,
        state: OutcomeState.UNKNOWN,
        result: null,
        providerReference: null,
        createdAt: existing?.createdAt ?? startedAt,
        updatedAt: startedAt,
      });

      try {
        const result = await adapter.execute({ operationId, effectHash, payload, metadata });
        const record = {
          operationId,
          effectHash,
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
