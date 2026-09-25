import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
} from "@once-agent/sdk/connect";

test("public Connect export classifies tool descriptors", () => {
  assert.equal(
    classifyConnectTool({ name: "send_email" }).decision,
    CONNECT_TOOL_DECISION.PROTECT,
  );

  assert.equal(
    classifyConnectTool({ name: "search_web" }).decision,
    CONNECT_TOOL_DECISION.BYPASS,
  );
});
