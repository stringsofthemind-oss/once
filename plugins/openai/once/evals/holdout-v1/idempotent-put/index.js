export async function replaceSettings(userId, settings) {
  const response = await fetch(`https://settings.example.test/v1/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings)
  });

  if (!response.ok) throw new Error(`settings update failed: ${response.status}`);
  return response.json();
}
