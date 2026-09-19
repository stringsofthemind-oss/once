export async function publishEvent(producer: any) {
  return producer.send({
    topic: "orders",
    messages: []
  });
}
