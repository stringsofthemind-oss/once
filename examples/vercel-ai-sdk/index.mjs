import { generateText, tool } from "ai";
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
  description:
    "Refund an order. Use for consequential refund operations.",

  inputSchema: z.object({
    orderId: z.string().min(1)
  }),

  async execute({ orderId }) {
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

    return {
      operationId,
      state: result.state
    };
  }
});

const orderId = process.argv[2] || "order_123";

const result = await generateText({
  model: "openai/gpt-5.5",

  tools: {
    refundOrder
  },

  toolChoice: {
    type: "tool",
    toolName: "refundOrder"
  },

  prompt: `Refund order ${orderId}.`
});

const toolResults = result.steps.flatMap(
  step => step.toolResults
);

console.log(JSON.stringify(toolResults, null, 2));