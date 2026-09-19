// HIGH: outbound HTTP delete
// This may expose a false DATABASE match too.
export async function deleteRemoteObject() {
  return axios.delete(
    "https://api.example.com/object/123"
  );
}
