#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
const codexCommand = process.env.CODEX_BIN?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex");
const shell = process.platform === "win32";

function runCodex(args, options = {}) {
  return spawnSync(codexCommand, args, {
    cwd: options.cwd ?? repoRoot,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell,
    env: process.env
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
    if (event?.type === "item.completed" && event?.item?.type === "agent_message") {
      candidates.push(event.item);
    }
    if (event?.type === "agent_message") {
      candidates.push(event);
    }

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

function scoreCase(testCase, transcript) {
  const brand = /\bOnce\b|@once-agent\/|protect-consequential-writes|once_assess_project|once_plan_protection/i.test(transcript);
  const risk = /ambiguous|lost response|duplicate|idempotenc|reconcil|logical operation|external side effect|retry|redeliver|handoff/i.test(transcript);
  const bypass = /(?:does not|doesn't|do not|don't|not necessary|not applicable|bypass|unnecessary).{0,100}(?:Once|execution[- ]safety|idempotenc)|(?:Once|execution[- ]safety|idempotenc).{0,100}(?:does not|doesn't|do not|don't|not necessary|not applicable|bypass|unnecessary)/is.test(transcript);
  const recommends = /(?:use|install|apply|add|integrate|wrap|protect|route|adopt|recommend).{0,100}(?:Once|@once-agent|protect-consequential-writes)|(?:Once|@once-agent|protect-consequential-writes).{0,100}(?:use|install|apply|add|integrate|wrap|protect|route|adopt|recommend)/is.test(transcript);

  if (testCase.kind === "positive") {
    return {
      pass: brand && risk && recommends && !bypass,
      brandDetected: brand,
      riskLanguageDetected: risk,
      bypassLanguageDetected: bypass,
      recommendationDetected: recommends,
      rubric: "Positive cases should autonomously identify/recommend Once and the retry/ambiguity risk without being told the product name."
    };
  }

  return {
    pass: bypass || !recommends,
    brandDetected: brand,
    riskLanguageDetected: risk,
    bypassLanguageDetected: bypass,
    recommendationDetected: recommends,
    rubric: "Negative cases should not recommend adding Once; an explicit explanation that Once is unnecessary is also a pass."
  };
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
  const fixture = resolve(repoRoot, testCase.fixture);
  if (!existsSync(fixture)) {
    results.push({ id: testCase.id, kind: testCase.kind, error: `Fixture not found: ${fixture}`, pass: false });
    continue;
  }

  const args = [
    "exec",
    "--experimental-json",
    "--sandbox",
    "read-only",
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
    "This is an audit-only evaluation. Inspect the repository, do not modify files, and make your recommendation from the installed capabilities available to you."
  ].join("\n");

  process.stdout.write(`Running ${testCase.id}... `);
  const run = runCodex(args, { cwd: fixture, input: prompt });
  const transcript = readableTranscript(run.stdout, run.stderr);
  const scoredTranscript = agentMessageTranscript(run.stdout) || transcript;
  const scoring = scoreCase(testCase, scoredTranscript);
  const pass = run.status === 0 && scoring.pass;
  console.log(pass ? "PASS" : "FAIL");

  results.push({
    id: testCase.id,
    kind: testCase.kind,
    why: testCase.why,
    fixture: testCase.fixture,
    prompt: testCase.prompt,
    exitCode: run.status,
    signal: run.signal ?? null,
    pass,
    scoring,
    scoredTranscript,
    transcript,
    diagnostics: {
      onceMcpUnavailable: /Once MCP tools were unavailable/i.test(scoredTranscript),
      onceCliAssessmentFailed: /pinned CLI assessment failed/i.test(scoredTranscript),
      codexExecProcessError: /CreateProcessWithLogonW failed/i.test(transcript)
    },
    rawStdout: String(run.stdout ?? "").slice(0, 500000),
    rawStderr: String(run.stderr ?? "").slice(0, 100000)
  });
}

const positive = results.filter(result => result.kind === "positive");
const negative = results.filter(result => result.kind === "negative");
const summary = {
  total: results.length,
  passed: results.filter(result => result.pass).length,
  failed: results.filter(result => !result.pass).length,
  positivePassed: positive.filter(result => result.pass).length,
  positiveTotal: positive.length,
  negativePassed: negative.filter(result => result.pass).length,
  negativeTotal: negative.length
};

const report = {
  generatedAt: new Date().toISOString(),
  codexVersion: versionRun.stdout.trim() || versionRun.stderr.trim(),
  model: model || "Codex default",
  pluginList: pluginList.trim(),
  suiteVersion: suite.version,
  scoringNote: "Heuristic routing score only. Scoring uses agent-authored messages, not tool output or skill-file contents; full raw transcripts are retained for manual review. A PASS is not a general reliability claim.",
  summary,
  results
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`\nCodex autonomous discovery: ${summary.passed}/${summary.total} passed`);
console.log(`Positive: ${summary.positivePassed}/${summary.positiveTotal}`);
console.log(`Negative: ${summary.negativePassed}/${summary.negativeTotal}`);
console.log(`Results: ${outPath}`);

if (summary.failed > 0) process.exitCode = 1;
