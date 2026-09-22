export async function createPayout(job) {
  const response = await fetch("https://payouts.example.test/v1/payouts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: job.account, amount: job.amount, currency: job.currency })
  });

  if (!response.ok) throw new Error(`payout failed: ${response.status}`);
  return response.json();
}

export async function run(job) {
  try {
    return await createPayout(job);
  } catch (error) {
    if (job.retryable !== false) return createPayout(job);
    throw error;
  }
}
