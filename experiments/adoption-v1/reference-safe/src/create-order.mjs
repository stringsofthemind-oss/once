export function createOrderTool({ provider }) {
  return async function createOrder(input) {
    if (
      !input ||
      typeof input.operationId !== "string" ||
      input.operationId.length === 0
    ) {
      throw new Error("STABLE_OPERATION_ID_REQUIRED");
    }

    // Reconcile before attempting any external side effect.
    //
    // This makes repeated calls and fresh runtime instances safe
    // when the provider already contains the committed operation.
    const existing =
      provider.findByOperationId(input.operationId);

    if (existing) {
      return existing;
    }

    try {
      return await provider.createOrder({
        operationId: input.operationId,
        sku: input.sku,
        quantity: input.quantity
      });
    } catch (error) {
      if (error?.code !== "AMBIGUOUS_AFTER_COMMIT") {
        throw error;
      }

      // The request may have committed even though its response
      // disappeared. Reconcile durable external state before making
      // any decision about another execution.
      const reconciled =
        provider.findByOperationId(input.operationId);

      if (reconciled) {
        return reconciled;
      }

      // Unknown means fail closed.
      //
      // We deliberately DO NOT call createOrder again here.
      const unknown = new Error(
        "ORDER_OUTCOME_UNKNOWN_RETRY_BLOCKED"
      );

      unknown.code = "OUTCOME_UNKNOWN";
      throw unknown;
    }
  };
}
