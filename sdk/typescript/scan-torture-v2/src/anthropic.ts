export async function askClaude(client: any) {
  return client.messages.create({
    model: "claude-sonnet",
    max_tokens: 100,
    messages: []
  });
}
