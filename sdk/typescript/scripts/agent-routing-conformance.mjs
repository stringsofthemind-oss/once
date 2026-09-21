#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const defaultSuitePath = path.join(
  repositoryRoot,
  "docs",
  "agent-routing-conformance-v1.json"
);

const CONDITION_KEYS = [
  "changes_external_state",
  "same_logical_operation_may_retry",
  "first_attempt_can_be_ambiguous",
  "blind_duplicate_undesirable_or_costly"
];

const ROUTES = new Set([
  "BYPASS_ONCE",
  "EVALUATE_ONCE"
]);

const ACTIONS = new Set([
  "DIRECT",
  "PROTECT",
  "EXECUTE",
  "REPLAY_OR_SUPPRESS",
  "BLOCK_AND_RECONCILE"
]);

const RUNTIME_ACTION = {
  ABSENT: "EXECUTE",
  CONFIRMED: "REPLAY_OR_SUPPRESS",
  UNKNOWN: "BLOCK_AND_RECONCILE"
};

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function loadCanonicalSuite(suitePath = defaultSuitePath) {
  return JSON.parse(await readFile(suitePath, "utf8"));
}

export function expectedRouteFromConditions(conditions) {
  return CONDITION_KEYS.every(key => conditions[key] === true)
    ? "EVALUATE_ONCE"
    : "BYPASS_ONCE";
}

export function validateCanonicalSuite(suite) {
  if (!isObject(suite)) {
    fail("routing conformance suite must be an object");
  }

  if (suite.schema_version !== "once-agent-routing-conformance-v1") {
    fail("unexpected routing conformance schema version");
  }

  if (suite.contract_schema_version !== "once-agent-discovery-v1") {
    fail("routing suite must target once-agent-discovery-v1");
  }

  if (!String(suite.scope ?? "").includes("current execution-safety")) {
    fail("routing suite scope must remain limited to the current execution-safety product");
  }

  if (!String(suite.scope_note ?? "").includes("has_changed")) {
    fail("routing suite must preserve the freshness / has_changed scope boundary");
  }

  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    fail("routing conformance suite must contain cases");
  }

  const seen = new Set();
  let bypass = 0;
  let evaluate = 0;
  let runtimeStateCases = 0;

  for (const testCase of suite.cases) {
    if (!isObject(testCase)) {
      fail("every routing case must be an object");
    }

    if (typeof testCase.id !== "string" || testCase.id.length === 0) {
      fail("every routing case requires a non-empty id");
    }

    if (seen.has(testCase.id)) {
      fail(`duplicate routing case id: ${testCase.id}`);
    }
    seen.add(testCase.id);

    if (typeof testCase.description !== "string" || testCase.description.length === 0) {
      fail(`routing case ${testCase.id} requires a description`);
    }

    if (!isObject(testCase.conditions)) {
      fail(`routing case ${testCase.id} requires labeled conditions`);
    }

    for (const key of CONDITION_KEYS) {
      if (typeof testCase.conditions[key] !== "boolean") {
        fail(`routing case ${testCase.id} condition ${key} must be boolean`);
      }
    }

    if (!isObject(testCase.expected)) {
      fail(`routing case ${testCase.id} requires an expected decision`);
    }

    if (!ROUTES.has(testCase.expected.route)) {
      fail(`routing case ${testCase.id} has invalid expected route`);
    }

    if (!ACTIONS.has(testCase.expected.action)) {
      fail(`routing case ${testCase.id} has invalid expected action`);
    }

    const derivedRoute = expectedRouteFromConditions(testCase.conditions);
    if (derivedRoute !== testCase.expected.route) {
      fail(
        `routing case ${testCase.id} violates the four-condition rule: ` +
        `derived ${derivedRoute}, fixture says ${testCase.expected.route}`
      );
    }

    if (testCase.expected.route === "BYPASS_ONCE") {
      bypass += 1;
      if (testCase.expected.action !== "DIRECT") {
        fail(`bypass case ${testCase.id} must use DIRECT`);
      }
    } else {
      evaluate += 1;

      if (testCase.runtime_state === undefined) {
        if (testCase.expected.action !== "PROTECT") {
          fail(`generic Once routing case ${testCase.id} must use PROTECT`);
        }
      } else {
        const expectedRuntimeAction = RUNTIME_ACTION[testCase.runtime_state];
        if (!expectedRuntimeAction) {
          fail(`routing case ${testCase.id} has invalid runtime_state`);
        }
        runtimeStateCases += 1;

        if (testCase.expected.action !== expectedRuntimeAction) {
          fail(
            `routing case ${testCase.id} action does not match runtime state ` +
            `${testCase.runtime_state}`
          );
        }
      }
    }
  }

  const freshnessCase = suite.cases.find(
    testCase => testCase.id === "poll_npm_package_version"
  );

  if (!freshnessCase) {
    fail("suite must retain the explicit freshness boundary case");
  }

  if (
    freshnessCase.expected.route !== "BYPASS_ONCE" ||
    !String(freshnessCase.scope_note ?? "").includes("future freshness")
  ) {
    fail("freshness boundary case must remain outside current Once execution routing");
  }

  if (bypass === 0 || evaluate === 0 || runtimeStateCases < 3) {
    fail("suite must include bypass, protect, and all three runtime-state behaviors");
  }

  return {
    cases: suite.cases.length,
    bypass,
    evaluate,
    runtimeStateCases
  };
}

export function emitBlindCases(suite) {
  validateCanonicalSuite(suite);

  return {
    schema_version: "once-agent-routing-cases-v1",
    contract_schema_version: suite.contract_schema_version,
    instructions: [
      "Read the Once agent discovery contract before evaluating these cases.",
      "For each case return route and action only from the allowed values.",
      "Do not treat freshness / has_changed as part of the current Once execution-safety product."
    ],
    allowed_routes: [...ROUTES],
    allowed_actions: [...ACTIONS],
    cases: suite.cases.map(testCase => ({
      case_id: testCase.id,
      scenario: testCase.description,
      ...(testCase.runtime_state === undefined
        ? {}
        : { runtime_state: testCase.runtime_state })
    }))
  };
}

export function buildPerfectTrace(suite) {
  validateCanonicalSuite(suite);

  return {
    schema_version: "once-agent-routing-evaluation-v1",
    suite_version: suite.schema_version,
    contract_schema_version: suite.contract_schema_version,
    decisions: suite.cases.map(testCase => ({
      case_id: testCase.id,
      route: testCase.expected.route,
      action: testCase.expected.action,
      ...(testCase.runtime_state === undefined
        ? {}
        : { runtime_state: testCase.runtime_state })
    }))
  };
}

export function evaluateRoutingTrace(suite, trace) {
  validateCanonicalSuite(suite);

  if (!isObject(trace)) {
    fail("routing evaluation trace must be an object");
  }

  if (trace.schema_version !== "once-agent-routing-evaluation-v1") {
    fail("unexpected routing evaluation trace schema version");
  }

  if (trace.suite_version !== suite.schema_version) {
    fail("routing trace suite_version does not match the canonical suite");
  }

  if (trace.contract_schema_version !== suite.contract_schema_version) {
    fail("routing trace contract_schema_version does not match the suite");
  }

  if (!Array.isArray(trace.decisions)) {
    fail("routing trace decisions must be an array");
  }

  const expectedById = new Map(
    suite.cases.map(testCase => [testCase.id, testCase])
  );

  const actualById = new Map();
  const duplicates = [];

  for (const decision of trace.decisions) {
    if (!isObject(decision) || typeof decision.case_id !== "string") {
      fail("every routing trace decision requires case_id");
    }

    if (actualById.has(decision.case_id)) {
      duplicates.push(decision.case_id);
      continue;
    }

    actualById.set(decision.case_id, decision);
  }

  const missing = [];
  const unexpected = [];
  const overRoutes = [];
  const underRoutes = [];
  const invalidRoutes = [];
  const actionMismatches = [];
  const runtimeStateMismatches = [];
  const passedCases = [];

  for (const caseId of actualById.keys()) {
    if (!expectedById.has(caseId)) {
      unexpected.push(caseId);
    }
  }

  for (const testCase of suite.cases) {
    const decision = actualById.get(testCase.id);

    if (!decision) {
      missing.push(testCase.id);
      continue;
    }

    let casePass = true;

    if (!ROUTES.has(decision.route)) {
      invalidRoutes.push(testCase.id);
      casePass = false;
    } else if (decision.route !== testCase.expected.route) {
      if (
        testCase.expected.route === "BYPASS_ONCE" &&
        decision.route === "EVALUATE_ONCE"
      ) {
        overRoutes.push(testCase.id);
      } else if (
        testCase.expected.route === "EVALUATE_ONCE" &&
        decision.route === "BYPASS_ONCE"
      ) {
        underRoutes.push(testCase.id);
      } else {
        invalidRoutes.push(testCase.id);
      }
      casePass = false;
    }

    if (!ACTIONS.has(decision.action) || decision.action !== testCase.expected.action) {
      actionMismatches.push(testCase.id);
      casePass = false;
    }

    if (testCase.runtime_state !== undefined) {
      if (decision.runtime_state !== testCase.runtime_state) {
        runtimeStateMismatches.push(testCase.id);
        casePass = false;
      }
    }

    if (casePass) {
      passedCases.push(testCase.id);
    }
  }

  const pass =
    duplicates.length === 0 &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    overRoutes.length === 0 &&
    underRoutes.length === 0 &&
    invalidRoutes.length === 0 &&
    actionMismatches.length === 0 &&
    runtimeStateMismatches.length === 0 &&
    passedCases.length === suite.cases.length;

  return {
    pass,
    total: suite.cases.length,
    passed: passedCases.length,
    duplicates,
    missing,
    unexpected,
    overRoutes,
    underRoutes,
    invalidRoutes,
    actionMismatches,
    runtimeStateMismatches
  };
}

function printSuiteSummary(summary) {
  console.log("Once Agent Routing Conformance Suite");
  console.log("------------------------------------");
  console.log(`Cases: ${summary.cases}`);
  console.log(`Expected bypass: ${summary.bypass}`);
  console.log(`Expected Once evaluation: ${summary.evaluate}`);
  console.log(`Explicit runtime-state cases: ${summary.runtimeStateCases}`);
  console.log("Answer key consistency: PASS");
}

function printEvaluation(result) {
  console.log("Once Agent Routing Conformance");
  console.log("------------------------------");
  console.log(`Cases: ${result.total}`);
  console.log(`Passed: ${result.passed}`);
  console.log(`Over-routes: ${result.overRoutes.length}`);
  console.log(`Under-routes: ${result.underRoutes.length}`);
  console.log(`Invalid routes: ${result.invalidRoutes.length}`);
  console.log(`Action mismatches: ${result.actionMismatches.length}`);
  console.log(`Runtime-state mismatches: ${result.runtimeStateMismatches.length}`);
  console.log(`Missing decisions: ${result.missing.length}`);
  console.log(`Unexpected decisions: ${result.unexpected.length}`);
  console.log(`Duplicate decisions: ${result.duplicates.length}`);
  console.log(`Conformance: ${result.pass ? "PASS" : "FAIL"}`);

  const groups = [
    ["Over-routed", result.overRoutes],
    ["Under-routed", result.underRoutes],
    ["Invalid route", result.invalidRoutes],
    ["Action mismatch", result.actionMismatches],
    ["Runtime-state mismatch", result.runtimeStateMismatches],
    ["Missing", result.missing],
    ["Unexpected", result.unexpected],
    ["Duplicate", result.duplicates]
  ];

  for (const [label, values] of groups) {
    if (values.length > 0) {
      console.log(`${label}: ${values.join(", ")}`);
    }
  }
}

async function main() {
  const suite = await loadCanonicalSuite();

  if (process.argv.includes("--emit-cases")) {
    console.log(JSON.stringify(emitBlindCases(suite), null, 2));
    return;
  }

  const tracePath = process.argv.slice(2).find(value => !value.startsWith("--"));

  if (!tracePath) {
    printSuiteSummary(validateCanonicalSuite(suite));
    console.log("");
    console.log("To emit blind scenarios:");
    console.log("  node ./scripts/agent-routing-conformance.mjs --emit-cases");
    console.log("");
    console.log("To validate an agent decision trace:");
    console.log("  node ./scripts/agent-routing-conformance.mjs <agent-evaluation-trace.json>");
    return;
  }

  const trace = JSON.parse(await readFile(path.resolve(tracePath), "utf8"));
  const result = evaluateRoutingTrace(suite, trace);
  printEvaluation(result);

  if (!result.pass) {
    process.exitCode = 1;
  }
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsScript) {
  main().catch(error => {
    console.error("");
    console.error("Agent routing conformance failed.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
