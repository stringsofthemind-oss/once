export async function sendCustomerEmail(task) {
  const response = await fetch("https://mail.example.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: task.to, subject: task.subject, body: task.body })
  });

  if (!response.ok) throw new Error(`mail failed: ${response.status}`);
  return response.json();
}

export async function consume(task) {
  try {
    return await sendCustomerEmail(task);
  } catch {
    return sendCustomerEmail(task);
  }
}
