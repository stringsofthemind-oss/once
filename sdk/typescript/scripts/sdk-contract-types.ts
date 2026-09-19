import { Once } from "../src/index.js";

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