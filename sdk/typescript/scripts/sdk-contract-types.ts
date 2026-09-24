import { Once, protectLocal } from "../src/index.js";

type ExistingInput = {
  provider: { createOrder(input: { orderId: string; amountCents: number }): Promise<{ receipt: string }> };
  orderId: string;
  amountCents: number;
};

const existing = async ({ provider, orderId, amountCents }: ExistingInput) =>
  provider.createOrder({ orderId, amountCents });

const protectedExisting: (input: ExistingInput) => Promise<{ receipt: string }> =
  protectLocal(existing, {
    id: ({ orderId }) => `order:${orderId}`,
    payload: ({ orderId, amountCents }) => ({ orderId, amountCents }),
  });

void protectedExisting;

const receiver = {
  prefix: "order",
  async run(this: { prefix: string }, input: { id: string; amount: number }) {
    return { receipt: `${this.prefix}:${input.amount}` };
  },
};
receiver.run = protectLocal(receiver.run, {
  id: input => input.id,
  payload: input => ({ amount: input.amount }),
});
void receiver;

declare const once: Once;

async function contract(): Promise<void> {

  const execution =
    await once.execute({
      operationId:
        "contract-operation",
      provider:
        "contract-provider",
      action: {
        type:
          "contract_test"
      }
    });

  const executionState:
    string =
      execution.state;

  const truth =
    await once.truth(
      "contract-operation"
    );

  const truthState:
    string =
      truth.ledger_state;

  void executionState;
  void truthState;
}

void contract;
