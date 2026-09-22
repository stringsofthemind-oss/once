#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, m => m.slice(1)));
const defaultCases = resolve(repoRoot, "plugins/openai/once/evals/autonomous-discovery-cases.json");

function argValue(name) {
  const prefix = `${name}=`;
  const direct = process.argv.find(arg => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return undefined;
}

const casesPath = resolve(argValue("--cases") ?? defaultCases);
const outPath = resolve(argValue("--out") ?? "codex-autonomous-discovery-results.json");
const onlyCase = argValue("--case");
const model = process.env.CODEX_EVAL_MODEL?.trim();
const sandboxMode = process.env.CODEX_EVAL_SANDBOX?.trim() || "danger-full-access";
const codexCommand = process.env.CODEX_BIN?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex");
const shell = process.platform === "win32";
const ONCE_TOOL_RE = /^once_(?:assess_project|plan_protection|apply_protection|explain_risk|live_proof|plan_setup|setup_project|verify_connection)$/i;

function runCodex(args, options = {}) {
  return spawnSync(codexCommand, args, {
    cwd: options.cwd ?? repoRoot,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell,
    env: {
      ...process.env,
      ...(options.env ?? {})
    }
  });
}

function collectStrings(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
}

function readableTranscript(stdout, stderr) {
  const strings = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      collectStrings(JSON.parse(line), strings);
    } catch {
      strings.push(line);
    }
  }
  if (stderr?.trim()) strings.push(stderr.trim());
  return strings.join("\n");
}

function infrastructureEvidence(stdout, stderr) {
  const strings = [];

  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.type === "error") {
      collectStrings(event, strings);
      continue;
    }

    if (event?.type === "item.completed" && event?.item?.type === "error") {
      collectStrings(event.item, strings);
      continue;
    }

    if (
      event?.type === "item.completed" &&
      event?.item?.type === "command_execution" &&
      (event.item.exit_code !== 0 || event.item.status === "failed")
    ) {
      if (typeof event.item.aggregated_output === "string" && event.item.aggregated_output.trim()) {
        strings.push(event.item.aggregated_output.trim());
      }
      if (typeof event.item.error === "string" && event.item.error.trim()) {
        strings.push(event.item.error.trim());
      }
    }
  }

  if (stderr?.trim()) strings.push(stderr.trim());
  return strings.join("\n");
}

function classifyInfrastructureBlock(transcript) {
  const text = String(transcript ?? "");
  const cases = [
    {
      code: "BLOCKED_API_CREDITS",
      patterns: [
        /no credits remaining/i,
        /add credits to continue using the api/i,
        /insufficient[_\s-]*quota/i,
        /exceeded your current quota/i
      ]
    },
    {
      code: "BLOCKED_API_RATE_LIMIT",
      patterns: [
        /rate limit exceeded/i,
        /tokens per min \(TPM\)/i,
        /too many requests/i
      ]
    },
    {
      code: "BLOCKED_API_AUTH",
      patterns: [
        /incorrect api key/i,
        /invalid api key/i,
        /authentication (?:failed|error)/i,
        /\bunauthorized\b/i
      ]
    },
    {
      code: "BLOCKED_API_CONNECTIVITY",
      patterns: [
        /connection (?:error|failed|reset)/i,
        /network (?:error|unreachable)/i,
        /timed? out connecting/i
      ]
    },
    {
      code: "BLOCKED_SANDBOX",
      patterns: [
        /bwrap:.*Operation not permitted/i,
        /sandbox.{0,120}Operation not permitted/i,
        /(?:shell|command).{0,100}(?:blocked|failing).{0,100}Operation not permitted/i,
        /environment.{0,100}blocks? even basic reads/i
      ]
    }
  ];

  return cases.find(item => item.patterns.some(pattern => pattern.test(text))) ?? null;
}

function agentMessageTranscript(stdout) {
  const messages = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const candidates = [];
    if (event?.type === "item.completed" && event?.item?.type === "agent_message") candidates.push(event.item);
    if (event?.type === "agent_message") candidates.push(event);

    for (const candidate of candidates) {
      if (typeof candidate.text === "string" && candidate.text.trim()) {
        messages.push(candidate.text.trim());
        continue;
      }
      if (typeof candidate.message === "string" && candidate.message.trim()) {
        messages.push(candidate.message.trim());
        continue;
      }
      if (candidate.content !== undefined) {
        const strings = [];
        collectStrings(candidate.content, strings);
        const text = strings.join("\n").trim();
        if (text) messages.push(text);
      }
    }
  }
  return messages.join("\n");
}

function agentMessageCount(stdout) {
  let count = 0;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event?.item?.type === "agent_message") count += 1;
      else if (event?.type === "agent_message") count += 1;
    } catch {
      // Ignore non-JSON output.
    }
  }
  return count;
}

function onceToolInvocations(stdout) {
  const byKey = new Map();

  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const item = event?.item?.type === "mcp_tool_call"
      ? event.item
      : event?.type === "mcp_tool_call"
        ? event
        : null;

    if (!item) continue;
    if (String(item.server ?? "").toLowerCase() !== "once") continue;
    if (!ONCE_TOOL_RE.test(String(item.tool ?? ""))) continue;

    const key = item.id ? `id:${item.id}` : `tool:${String(item.tool).toLowerCase()}`;
    const prior = byKey.get(key);
    byKey.set(key, {
      id: item.id ?? prior?.id ?? null,
      server: "once",
      tool: String(item.tool),
      status: item.status ?? prior?.status ?? null
    });
  }

  return [...byKey.values()];
}

function normalizeOnceProductReferences(transcript) {
  return String(transcript ?? "")
    .replace(/\bOnce\b/g, "ONCE_PRODUCT")
    .replace(/once:protect-consequential-writes/gi, "ONCE_PRODUCT")
    .replace(/@once-agent(?:\/[A-Za-z0-9._/-]+)?/gi, "ONCE_PRODUCT")
    .replace(/\bprotect-consequential-writes\b/gi, "ONCE_PRODUCT")
    .replace(/\bonce_(?:assess_project|plan_protection|apply_protection|explain_risk|live_proof|plan_setup|setup_project|verify_connection)\b/gi, "ONCE_PRODUCT")
    .replace(/\bonce\s+(?:plugin|skill|agent|library|product|mcp)\b/gi, "ONCE_PRODUCT");
}

function hasExplicitOnceBypass(transcript) {
  const text = normalizeOnceProductReferences(transcript);
  const onceRef = "ONCE_PRODUCT";
  const patterns = [
    new RegExp(`(?:do not|don't|should not|shouldn't|avoid|skip)\\s+(?:use|install|apply|add|integrate|adopt|recommend)\\s+(?:the\\s+)?${onceRef}\\b`, "i"),
    new RegExp(`\\b${onceRef}\\b.{0,80}\\b(?:is|would be|was)\\s+(?:not\\s+(?:needed|necessary|applicable|appropriate|relevant)|unnecessary)\\b`, "is"),
    new RegExp(`\\b${onceRef}\\b.{0,180}\\b(?:does not|doesn't|would not|wouldn't)\\s+(?:apply|fit|solve|address|mitigate)\\b`, "is"),
    new RegExp(`\\b${onceRef}\\b.{0,120}\\b(?:is|are|would be|was|were)\\s+(?:disproportionate|overkill|unwarranted)\\b`, "is"),
    new RegExp(`\\b(?:this|the operation|the task|the workflow|the code|it)\\b.{0,30}\\b(?:does not|doesn't)\\s+(?:need|require)\\s+${onceRef}\\b`, "is"),
    new RegExp(`\\bbypass\\s+${onceRef}\\b`, "i"),
    new RegExp(`\\b${onceRef}\\b.{0,40}\\bshould be bypassed\\b`, "is")
  ];
  return patterns.some(pattern => pattern.test(text));
}

function scoreCase(testCase, transcript, evidence = {}) {
  const productTranscript = normalizeOnceProductReferences(transcript);
  const onceToolSelected = Boolean(evidence.onceToolSelected);
  const brand = productTranscript.includes("ONCE_PRODUCT") || onceToolSelected;
  const risk = /ambiguous|lost response|duplicate|idempotenc|reconcil|logical operation|external side effect|retry|redeliver|handoff/i.test(transcript);
  const bypass = hasExplicitOnceBypass(transcript);
  const onceRef = "ONCE_PRODUCT";
  const recommendationVerb = "(?:use|install|apply|add|integrate|wrap|protect|route|adopt|recommend(?:s|ed|ing)?)";
  const proseRecommendation = new RegExp(
    `(?:\\b${recommendationVerb}\\b.{0,100}\\b${onceRef}\\b|\\b${onceRef}\\b.{0,100}\\b${recommendationVerb}\\b)`,
    "is"
  ).test(productTranscript);
  const recommends = proseRecommendation || onceToolSelected;

  if (testCase.kind === "positive") {
    return {
      pass: brand && risk && recommends && !bypass,
      brandDetected: brand,
      riskLanguageDetected: risk,
      bypassLanguageDetected: bypass,
      recommendationDetected: recommends,
      onceToolInvocationDetected: onceToolSelected,
      rubric: "Positive cases should autonomously identify, recommend, or select Once and identify the retry/ambiguity risk without being told the product name. A structured invocation of a Once MCP tool counts as explicit autonomous Once selection; tool-result content does not. Generic phrases such as 'exactly-once' do not count as a Once product reference."
    };
  }

  return {
    pass: bypass || !recommends,
    brandDetected: brand,
    riskLanguageDetected: risk,
    bypassLanguageDetected: bypass,
    recommendationDetected: recommends,
    onceToolInvocationDetected: onceToolSelected,
    rubric: "Negative cases should not recommend or select Once; an explicit explanation that Once is unnecessary is also a pass. A structured invocation of a Once MCP tool counts as explicit Once selection; tool-result content does not. Generic phrases such as 'exactly-once' do not count as a Once product reference."
  };
}

function makeFixtureCopy(sourceFixture, caseId) {
  const base = process.env.RUNNER_TEMP?.trim() || tmpdir();
  const runRoot = mkdtempSync(join(resolve(base), `once-codex-${caseId}-`));
  const fixture = join(runRoot, "project");
  cpSync(sourceFixture, fixture, { recursive: true });
  return { runRoot, fixture };
}

if (!existsSync(casesPath)) {
  console.error(`Cases file not found: ${casesPath}`);
  process.exit(2);
}

const versionRun = runCodex(["--version"]);
if (versionRun.status !== 0) {
  console.error("Codex CLI is not available. Install @openai/codex or set CODEX_BIN.");
  console.error(versionRun.stderr || versionRun.stdout || "");
  process.exit(2);
}

const pluginRun = runCodex(["plugin", "list"]);
const pluginList = `${pluginRun.stdout ?? ""}\n${pluginRun.stderr ?? ""}`;
if (pluginRun.status !== 0 || !/once@once-agent\s+installed, enabled/i.test(pluginList)) {
  console.error("Once is not installed and enabled in Codex.");
  console.error("Run:");
  console.error("  codex plugin marketplace add stringsofthemind-oss/once --ref main");
  console.error("  codex plugin add once@once-agent");
  console.error(pluginList.trim());
  process.exit(2);
}

const suite = JSON.parse(readFileSync(casesPath, "utf8"));
let selected = suite.cases;
if (onlyCase) {
  selected = selected.filter(testCase => testCase.id === onlyCase);
  if (selected.length === 0) {
    console.error(`Unknown case: ${onlyCase}`);
    process.exit(2);
  }
}

const results = [];
for (const testCase of selected) {
  const sourceFixture = resolve(repoRoot, testCase.fixture);
  if (!existsSync(sourceFixture)) {
    results.push({
      id: testCase.id,
      kind: testCase.kind,
      error: `Fixture not found: ${sourceFixture}`,
      pass: false,
      evaluationStatus: "evaluated",
      blockedReason: null
    });
    continue;
  }

  const { runRoot, fixture } = makeFixtureCopy(sourceFixture, testCase.id);
  try {
    const args = [
      "exec",
      "--experimental-json",
      "--sandbox",
      sandboxMode,
      "--cd",
      fixture,
      "--skip-git-repo-check",
      "--config",
      'approval_policy="never"',
      "--config",
      'web_search="disabled"'
    ];
    if (model) args.push("--model", model);

    const prompt = [
      testCase.prompt,
      "",
      `The repository to audit is exactly this directory: ${fixture}`,
      "Treat that directory as the project root for every inspection or project-scanning tool you choose to use. If a tool accepts a project path, pass the absolute directory above rather than relying on '.'.",
      "This is an audit-only evaluation. Inspect the repository, do not modify files, and make your recommendation from the installed capabilities available to you."
    ].join("\n");

    process.stdout.write(`Running ${testCase.id}... `);
    const run = runCodex(args, {
      cwd: fixture,
      input: prompt,
      env: { ONCE_EVAL_PROJECT_PATH: fixture }
    });
    const transcript = readableTranscript(run.stdout, run.stderr);
    const infrastructureTranscript = infrastructureEvidence(run.stdout, run.stderr);
    const infrastructureBlock = classifyInfrastructureBlock(infrastructureTranscript);
    const scoredTranscript = agentMessageTranscript(run.stdout) || transcript;
    const toolInvocations = onceToolInvocations(run.stdout);
    const scoring = infrastructureBlock
      ? null
      : scoreCase(testCase, scoredTranscript, { onceToolSelected: toolInvocations.length > 0 });
    const pass = infrastructureBlock ? null : run.status === 0 && scoring.pass;
    const evaluationStatus = infrastructureBlock ? "blocked" : "evaluated";

    console.log(infrastructureBlock ? infrastructureBlock.code : pass ? "PASS" : "FAIL");

    results.push({
      id: testCase.id,
      kind: testCase.kind,
      why: testCase.why,
      fixture: testCase.fixture,
      isolatedFixture: fixture,
      prompt: testCase.prompt,
      exitCode: run.status,
      signal: run.signal ?? null,
      pass,
      evaluationStatus,
      blockedReason: infrastructureBlock?.code ?? null,
      scoring,
      scoredTranscript,
      transcript,
      infrastructureTranscript,
      diagnostics: {
        onceMcpUnavailable: /Once MCP tools were unavailable|MCP server.*once.*(?:unavailable|failed)/i.test(transcript),
        onceCliAssessmentFailed: /once_assess_project.{0,160}(?:isError|failed)|Cannot find module.*@once-agent[\\/]sdk/i.test(transcript),
        codexExecProcessError: /CreateProcessWithLogonW failed/i.test(infrastructureTranscript),
        sandboxFailure: /bwrap:.*Operation not permitted|sandbox.{0,120}Operation not permitted/i.test(infrastructureTranscript),
        modelMetadataFallback: /Model metadata for `[^`]+` not found\. Defaulting to fallback metadata/i.test(transcript),
        agentMessageCount: agentMessageCount(run.stdout),
        onceToolInvoked: toolInvocations.length > 0,
        onceToolNames: toolInvocations.map(item => item.tool),
        targetPathMentioned: transcript.includes(fixture)
      },
      rawStdout: String(run.stdout ?? "").slice(0, 500000),
      rawStderr: String(run.stderr ?? "").slice(0, 100000)
    });
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

const evaluated = results.filter(result => result.evaluationStatus === "evaluated");
const blocked = results.filter(result => result.evaluationStatus === "blocked");
const positive = evaluated.filter(result => result.kind === "positive");
const negative = evaluated.filter(result => result.kind === "negative");

const summary = {
  total: results.length,
  evaluated: evaluated.length,
  blocked: blocked.length,
  passed: evaluated.filter(result => result.pass).length,
  failed: evaluated.filter(result => !result.pass).length,
  positivePassed: positive.filter(result => result.pass).length,
  positiveEvaluated: positive.length,
  positiveTotal: results.filter(result => result.kind === "positive").length,
  negativePassed: negative.filter(result => result.pass).length,
  negativeEvaluated: negative.length,
  negativeTotal: results.filter(result => result.kind === "negative").length
};

const report = {
  generatedAt: new Date().toISOString(),
  codexVersion: versionRun.stdout.trim() || versionRun.stderr.trim(),
  model: model || "Codex default",
  sandboxMode,
  pluginList: pluginList.trim(),
  suiteVersion: suite.version,
  scoringNote: "Heuristic routing score only. Infrastructure classification uses stderr plus structured Codex error/failed-command events, never agent-authored prose. Infrastructure-blocked cases are not graded and use pass=null. Each fixture is copied to an isolated temporary directory before Codex runs. Scoring uses agent-authored messages plus the structured identity of Once MCP tool invocations; MCP tool-result content and skill-file contents are excluded. A Once pass requires an explicit product/machine reference or an actual Once MCP invocation; generic language such as 'exactly-once' does not count. Full raw transcripts are retained for manual review. A PASS is not a general reliability claim.",
  summary,
  results
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (summary.blocked > 0) {
  const blockReasons = [...new Set(blocked.map(result => result.blockedReason).filter(Boolean))];
  console.log(`\nCodex autonomous discovery: BLOCKED (${summary.blocked}/${summary.total} cases not evaluated)`);
  console.log(`Block reason(s): ${blockReasons.join(", ") || "UNKNOWN_INFRASTRUCTURE_BLOCK"}`);
  console.log(`Evaluated: ${summary.evaluated}/${summary.total}`);
  if (summary.evaluated > 0) console.log(`Passed among evaluated: ${summary.passed}/${summary.evaluated}`);
} else {
  console.log(`\nCodex autonomous discovery: ${summary.passed}/${summary.total} passed`);
}

console.log(`Positive evaluated: ${summary.positivePassed}/${summary.positiveEvaluated}`);
console.log(`Negative evaluated: ${summary.negativePassed}/${summary.negativeEvaluated}`);
console.log(`Results: ${outPath}`);

if (summary.failed > 0) process.exitCode = 1;
else if (summary.blocked > 0) process.exitCode = 3;
