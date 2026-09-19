// SAFE: read-only search
export async function searchProducts(query: string) {
  return fetch(
    "https://example.com/search?q=" + query,
    {
      method: "GET"
    }
  );
}

// SAFE: read-only database query
export async function listUsers() {
  return prisma.user.findMany();
}

// SAFE: local read
export async function readConfig() {
  return readFile("./config.json", "utf8");
}
