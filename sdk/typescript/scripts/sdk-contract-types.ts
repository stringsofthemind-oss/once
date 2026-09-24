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
