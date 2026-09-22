export async function fetchProfile(userId, signal) {
  const response = await fetch(`https://directory.example.test/v1/users/${encodeURIComponent(userId)}`, {
    method: "GET",
    signal
  });

  if (!response.ok) throw new Error(`lookup failed: ${response.status}`);
  return response.json();
}

export async function loadWithRetry(userId, signal) {
  try {
    return await fetchProfile(userId, signal);
  } catch {
    return fetchProfile(userId, signal);
  }
}
