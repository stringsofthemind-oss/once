export function createOrderTool({ provider }) {
  return async function createOrder(input) {
    return await provider.createOrder({
      operationId: input.operationId,
      sku: input.sku,
      quantity: input.quantity
    });
  };
}
