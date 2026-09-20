import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { Once } from "@once-agent/sdk";
import { z } from "zod";

const once = new Once();
const provider = process.env.ONCE_PROVIDER_ALIAS;

if (!provider) {
  throw new Error(
    "ONCE_PROVIDER_ALIAS is required. Configure a supported Once provider first."
  );
}

const refundOrder = tool(
  async ({ orderId }) => {
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
  },
  {
    name: "refund_order",
    description:
      "Refund an order. Use this tool for consequential refund operations.",
    schema: z.object({
      orderId: z.string().min(1)
    })
  }
);

const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL || "gpt-4o-mini"
});

const agent = createAgent({
  model,
  tools: [refundOrder]
});

const orderId = process.argv[2] || "order_123";

const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content: `Refund order ${orderId}.`
    }
  ]
});

console.log(
  result.messages[result.messages.length - 1]?.content
);