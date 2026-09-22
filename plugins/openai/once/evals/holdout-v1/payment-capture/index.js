export async function capturePayment(job) {
  const response = await fetch("https://payments.example.test/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentId: job.paymentId, amount: job.amount })
  });

  if (!response.ok) throw new Error(`capture failed: ${response.status}`);
  return response.json();
}

export async function handleCapture(job) {
  try {
    return await capturePayment(job);
  } catch {
    return capturePayment(job);
  }
}
