export async function notifySlack(client: any) {
  return client.chat.postMessage({
    channel: "C123",
    text: "Order shipped"
  });
}
