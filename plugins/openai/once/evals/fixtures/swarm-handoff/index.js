export async function provisionResource(task) {
  const response = await fetch("https://infra.example.test/resources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceId: task.resourceId, spec: task.spec })
  });

  if (!response.ok) {
    throw new Error(`provision request failed: ${response.status}`);
  }

  return await response.json();
}

export async function handleDelivery(task) {
  // The queue is at-least-once. A different worker or agent may receive
  // the same logical task again after a timeout, crash, or lease expiry.
  return await provisionResource(task);
}
