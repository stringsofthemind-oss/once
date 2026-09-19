// MEDIUM: outbound HTTP write
export async function createRemoteOrder() {
  return fetch(
    "https://api.example.com/orders",
    {
      method: "POST"
    }
  );
}
