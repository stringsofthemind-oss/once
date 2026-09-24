import fs from "node:fs";
import path from "node:path";

export class AmbiguousOrderProvider {
  constructor(statePath) {
    this.statePath = statePath;
    this.failAfterCommit = new Set();
    this.#ensureState();
  }

  #ensureState() {
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.statePath)) {
      fs.writeFileSync(
        this.statePath,
        JSON.stringify({
          orders: [],
          calls: []
        }, null, 2)
      );
    }
  }

  #read() {
    return JSON.parse(
      fs.readFileSync(this.statePath, "utf8")
    );
  }

  #write(state) {
    fs.writeFileSync(
      this.statePath,
      JSON.stringify(state, null, 2)
    );
  }

  armAmbiguousFailure(operationId) {
    this.failAfterCommit.add(operationId);
  }

  async createOrder({ operationId, sku, quantity }) {
    const state = this.#read();

    const order = {
      providerOrderId: `provider_${state.orders.length + 1}`,
      operationId,
      sku,
      quantity
    };

    state.orders.push(order);

    state.calls.push({
      operationId,
      committed: true
    });

    this.#write(state);

    if (this.failAfterCommit.has(operationId)) {
      this.failAfterCommit.delete(operationId);

      const error = new Error(
        "NETWORK_DROPPED_AFTER_PROVIDER_COMMIT"
      );

      error.code = "AMBIGUOUS_AFTER_COMMIT";
      throw error;
    }

    return order;
  }

  findByOperationId(operationId) {
    const state = this.#read();

    return (
      state.orders.find(
        (order) => order.operationId === operationId
      ) ?? null
    );
  }

  getOrders() {
    return this.#read().orders;
  }

  getCalls() {
    return this.#read().calls;
  }
}
