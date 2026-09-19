import axios from "axios";

const api = axios;

export async function createRemoteThing() {
  return api.post(
    "https://example.com/things",
    { name: "test" }
  );
}
