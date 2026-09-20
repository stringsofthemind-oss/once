import { Agent, run, tool } from "@openai/agents";
import { Once } from "@once-agent/sdk";
import { z } from "zod";

const once = new Once();

const provider = process.env.ONCE_PROVIDER_ALIAS;

if (!provider) {
  throw new Error(
    "ONCE_PROVIDER_ALIAS is required. Configure a supported Once provider first."
  );
}

const refundOrder = tool({
  name: "refund_order",

  description:
    "Refund an order. Use this tool for consequential refund operations.",

  parameters: z.object({
    orderId: z.string().min(1)
  }),

  async execute({ orderId }) {
    // The logical refund gets the same identity every time the
    // agent retries this operation.
    const operationId = Once.id(
      "refund",
      orderId
    );

    const result = await once.execute({
      operationId,
      provider,
      action: {
        type: "refund",
        order_id: orderId
      }
    });

    return JSON.stringify({
      operationId,
      state: result.state
    });
  }
});

const agent = new Agent({
  name: "Refund agent",

  instructions: [
    "You handle refund requests.",
    "When the user requests a refund, use the refund_order tool.",
    "Never bypass the refund tool.",
    "The same logical refund may be retried after an ambiguous timeout."
  ].join(" "),

  tools: [
    refundOrder
  ]
});

const orderId =
  process.argv[2] ||
  "order_123";

console.log(
  `\nFirst agent request for ${orderId}\n`
);

const first = await run(
  agent,
  `Refund order ${orderId}.`
);

console.log(first.finalOutput);

console.log(
  `\nRetrying the same logical request for ${orderId}\n`
);

const retry = await run(
  agent,
  `Refund order ${orderId}. This is a retry of the same logical refund.`
);

console.log(retry.finalOutput);