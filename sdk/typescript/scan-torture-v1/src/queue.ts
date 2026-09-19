// MEDIUM: external queue/event publication
export async function publishJob() {
  return queue.publish({
    type: "invoice.created"
  });
}
