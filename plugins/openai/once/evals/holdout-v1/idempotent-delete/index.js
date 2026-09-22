export async function deleteResource(resourceId) {
  const response = await fetch(`https://resources.example.test/v1/resources/${encodeURIComponent(resourceId)}`, {
    method: "DELETE"
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`delete failed: ${response.status}`);
  }

  return { deleted: true };
}
