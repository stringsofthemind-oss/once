export async function fetchCustomerProfile(customerId) {
  const response = await fetch(`https://directory.example.test/customers/${customerId}`, {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error(`profile lookup failed: ${response.status}`);
  }

  return await response.json();
}
