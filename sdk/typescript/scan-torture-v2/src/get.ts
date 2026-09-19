export async function readCatalog() {
  return fetch("https://example.com/catalog", {
    method: "GET"
  });
}
