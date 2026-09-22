export async function issueRefund(orderId, amount) {
  const response = await fetch("https://payments.example.test/refunds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId, amount })
  });

  if (!response.ok) {
    throw new Error(`refund request failed: ${response.status}`);
  }

  return await response.json();
}

export async function runRefundJob(job) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await issueRefund(job.orderId, job.amount);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}
