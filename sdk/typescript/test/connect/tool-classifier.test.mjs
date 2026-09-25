import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
  classifyConnectTools,
} from "../../dist/connect/tool-classifier.js";

test("explicit MCP read-only annotation bypasses protection", () => {
  const result = classifyConnectTool({
    name: "search_web",
    description: "Search the public web.",
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.BYPASS);
  assert.equal(result.reason, "EXPLICIT_READ_ONLY");
});

test("explicit non-read-only tool is protected", () => {
  const result = classifyConnectTool({
    name: "perform_action",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.PROTECT);
  assert.equal(result.reason, "EXPLICIT_WRITE");
});

test("explicit idempotent write bypasses duplicate-effect protection", () => {
  const result = classifyConnectTool({
    name: "set_profile_flag",
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
    },
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.BYPASS);
  assert.equal(result.reason, "EXPLICIT_IDEMPOTENT_WRITE");
});

test("contradictory annotations resolve to UNKNOWN", () => {
  const result = classifyConnectTool({
    name: "mystery_tool",
    annotations: {
      readOnlyHint: true,
      destructiveHint: true,
    },
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.UNKNOWN);
  assert.equal(result.reason, "CONFLICTING_SIGNALS");
});

test("mutation semantics override an unsafe read-only hint with UNKNOWN", () => {
  const result = classifyConnectTool({
    name: "send_email",
    description: "Send an email to a recipient.",
    annotations: {
      readOnlyHint: true,
    },
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.UNKNOWN);
  assert.equal(result.reason, "CONFLICTING_SIGNALS");
});

test("read semantics conflict with an explicit write hint", () => {
  const result = classifyConnectTool({
    name: "get_customer",
    description: "Retrieve a customer record.",
    annotations: {
      readOnlyHint: false,
    },
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.UNKNOWN);
  assert.equal(result.reason, "CONFLICTING_SIGNALS");
});

test("send_email is inferred as PROTECT", () => {
  const result = classifyConnectTool({
    name: "send_email",
    description: "Send an email to a recipient.",
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.PROTECT);
  assert.equal(result.reason, "MUTATION_SIGNAL");
});

test("charge_customer is inferred as PROTECT", () => {
  const result = classifyConnectTool({
    name: "charge_customer",
    description: "Charge a customer for an order.",
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.PROTECT);
});

test("create_invoice is inferred as PROTECT", () => {
  assert.equal(
    classifyConnectTool({ name: "create_invoice" }).decision,
    CONNECT_TOOL_DECISION.PROTECT,
  );
});

test("delete_file is inferred as PROTECT", () => {
  assert.equal(
    classifyConnectTool({ name: "delete_file" }).decision,
    CONNECT_TOOL_DECISION.PROTECT,
  );
});

test("book_flight is inferred as PROTECT", () => {
  assert.equal(
    classifyConnectTool({ name: "book_flight" }).decision,
    CONNECT_TOOL_DECISION.PROTECT,
  );
});

test("search_web is inferred as BYPASS", () => {
  const result = classifyConnectTool({
    name: "search_web",
    description: "Search the public web and return matching pages.",
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.BYPASS);
  assert.equal(result.reason, "READ_ONLY_SIGNAL");
});

test("get_customer is inferred as BYPASS", () => {
  assert.equal(
    classifyConnectTool({ name: "get_customer" }).decision,
    CONNECT_TOOL_DECISION.BYPASS,
  );
});

test("retrieve_document is inferred as BYPASS", () => {
  assert.equal(
    classifyConnectTool({ name: "retrieve_document" }).decision,
    CONNECT_TOOL_DECISION.BYPASS,
  );
});

test("generation-only tools are inferred as BYPASS", () => {
  for (const name of [
    "generate_report",
    "summarize_document",
    "translate_text",
    "calculate_total",
  ]) {
    const result = classifyConnectTool({ name });

    assert.equal(
      result.decision,
      CONNECT_TOOL_DECISION.BYPASS,
      name,
    );
  }
});

test("mixed get-or-create semantics resolve to UNKNOWN", () => {
  const result = classifyConnectTool({
    name: "get_or_create_customer",
    description: "Get a customer or create one when absent.",
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.UNKNOWN);
  assert.equal(result.reason, "CONFLICTING_SIGNALS");
});

test("read-looking name with mutating description resolves to UNKNOWN", () => {
  const result = classifyConnectTool({
    name: "get_invoice",
    description: "Retrieves an invoice and updates its last-viewed timestamp.",
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.UNKNOWN);
  assert.equal(result.reason, "CONFLICTING_SIGNALS");
});

test("unknown tool semantics do not silently bypass", () => {
  const result = classifyConnectTool({
    name: "frobnicate_account",
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.UNKNOWN);
  assert.equal(result.reason, "INSUFFICIENT_EVIDENCE");
});

test("invalid descriptors resolve to UNKNOWN", () => {
  assert.equal(
    classifyConnectTool(null).decision,
    CONNECT_TOOL_DECISION.UNKNOWN,
  );

  assert.equal(
    classifyConnectTool({ name: "" }).decision,
    CONNECT_TOOL_DECISION.UNKNOWN,
  );
});

test("malformed annotations resolve to UNKNOWN", () => {
  const result = classifyConnectTool({
    name: "send_email",
    annotations: {
      readOnlyHint: "maybe",
    },
  });

  assert.equal(result.decision, CONNECT_TOOL_DECISION.UNKNOWN);
  assert.equal(result.reason, "INVALID_TOOL_ANNOTATIONS");
});

test("classifies a manifest without changing tool ordering", () => {
  const results = classifyConnectTools([
    { name: "search_web" },
    { name: "send_email" },
    { name: "mystery" },
  ]);

  assert.deepEqual(
    results.map(result => result.decision),
    [
      CONNECT_TOOL_DECISION.BYPASS,
      CONNECT_TOOL_DECISION.PROTECT,
      CONNECT_TOOL_DECISION.UNKNOWN,
    ],
  );
});
