export async function decrementInventory(task) {
  const response = await fetch(`https://inventory.example.test/v1/items/${task.sku}/decrement`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quantity: task.quantity, orderId: task.orderId })
  });

  if (!response.ok) throw new Error(`inventory failed: ${response.status}`);
  return response.json();
}

export async function consume(task) {
  return decrementInventory(task);
}
