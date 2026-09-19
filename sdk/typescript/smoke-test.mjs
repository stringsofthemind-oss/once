import { Once } from "./dist/index.js";
import { randomUUID } from "node:crypto";

const once = new Once();

const operationId =
  "sdk-smoke-" + randomUUID().replaceAll("-", "");

console.log("Operation:", operationId);

const first = await once.execute({
  operationId,
  provider: "blind_test",
  action: {
    type: "typescript_sdk_smoke_test"
  }
});

console.log("\nFIRST CALL");
console.log(first);

const second = await once.execute({
  operationId,
  provider: "blind_test",
  action: {
    type: "typescript_sdk_smoke_test"
  }
});

console.log("\nEXACT RETRY");
console.log(second);

const truth = await once.truth(operationId);

console.log("\nTRUTH");
console.log(truth);

if (truth.side_effects !== 1) {
  throw new Error(
    `SAFETY FAILURE: expected 1 side effect, got ${truth.side_effects}`
  );
}

console.log("\nSDK SAFETY TEST PASSED");
console.log("Exactly one provider side effect.");
