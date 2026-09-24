import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import worker from "../src/index.js";

function pageEnv() {
  return {
    EVALUATION_BYPASS_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_once_eval",
    STRIPE_PRICE_PRO: "price_eval_pro",
    EVALUATION_ADMISSION_SECRET: "test-admission-secret-0123456789abcdef",
    EVALUATION_MAX_PER_CLIENT_24H: "3",
    EVALUATION_GLOBAL_MAX_24H: "100",
    EVALUATION_ADMISSION: {},
    Q18_TRUTH: {},
    SANDBOX_CLAIMS: {},
  };
}

async function getWindowsInstaller() {
  const response = await worker.fetch(
    new Request("https://evaluate.onceexec.test/install/windows.cmd"),
    pageEnv(),
  );

  assert.equal(response.status, 200);
  return { response, installer: await response.text() };
}

test("activated onboarding isolates the API key and makes automatic Windows setup the primary path", async () => {
  const response = await worker.fetch(
    new Request("https://evaluate.onceexec.test/"),
    pageEnv(),
  );

  assert.equal(response.status, 200);
  const page = await response.text();

  assert.match(page, /Step 1 — Your API key/);
  assert.match(page, /Step 2 — Let Once install itself/);
  assert.match(page, /Step 3 — Open the downloaded setup file/);

  assert.match(page, /<code id="apiKey" class="copyvalue"><\/code>/);
  assert.match(page, /id="copyApiKey"[^>]*>Copy API key<\/button>/);
  assert.match(page, /apiKey\.textContent=body\.api_key/);
  assert.doesNotMatch(page, /result\.textContent=/);

  assert.match(page, /id="installWindows"[^>]*>Install Once on Windows<\/button>/);
  assert.match(page, /navigator\.clipboard\.writeText\(key\)/);
  assert.match(page, /link\.href="\/install\/windows\.cmd"/);
  assert.match(page, /link\.download="OnceSetup\.cmd"/);
  assert.match(page, /Choose <strong>Yes<\/strong> for a safe demo project/);
  assert.match(page, /The browser cannot silently run programs on your computer/);

  assert.match(page, /Manual setup \/ Mac \/ Linux/);
  assert.match(page, /npm install @once-agent\/sdk/);
  assert.match(page, /npx once setup \./);

  assert.match(page, /button\.hidden=true/);
  assert.match(page, /✓ Evaluation active/);
});

test("Windows installer download is generic, non-secret, and attachment-only", async () => {
  const { response, installer } = await getWindowsInstaller();

  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="OnceSetup.cmd"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  assert.match(installer, /^@echo off/);
  assert.match(installer, /#__ONCE_POWERSHELL__#/);
  assert.match(installer, /LastIndexOf\(\$marker\)/);
  assert.match(installer, /Clipboard.*GetText/);
  assert.match(installer, /once_test_/);
  assert.match(installer, /& \$Npm install @once-agent\/sdk/);
  assert.match(installer, /Once Evaluation Demo/);
  assert.match(installer, /api\.onceexec\.com\/v1\/truth/);
  assert.match(installer, /retry was suppressed/);

  assert.doesNotMatch(installer, /sk_test_/);
  assert.doesNotMatch(installer, /ONCE_API_KEY=once_test_/);
});

test("embedded Windows PowerShell payload parses cleanly when pwsh is available", async (t) => {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], {
    encoding: "utf8",
  });

  if (probe.error?.code === "ENOENT") {
    t.skip("pwsh is not installed on this test host");
    return;
  }

  assert.equal(probe.status, 0, probe.stderr || probe.stdout);

  const { installer } = await getWindowsInstaller();
  const marker = "#__ONCE_POWERSHELL__#";
  const markerIndex = installer.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1);

  const payload = installer.slice(markerIndex + marker.length).replace(/^\r?\n/, "");
  const tempRoot = mkdtempSync(path.join(tmpdir(), "once-windows-installer-"));
  const scriptPath = path.join(tempRoot, "OnceSetup.ps1");
  writeFileSync(scriptPath, payload, "utf8");

  try {
    const parserCommand = [
      "$tokens=$null",
      "$errors=$null",
      "[System.Management.Automation.Language.Parser]::ParseFile($env:ONCE_PS_PARSE_PATH,[ref]$tokens,[ref]$errors) | Out-Null",
      "if($errors.Count -gt 0){$errors | ForEach-Object { Write-Error $_.Message }; exit 1}",
    ].join(";");

    const parsed = spawnSync(
      "pwsh",
      ["-NoProfile", "-Command", parserCommand],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ONCE_PS_PARSE_PATH: scriptPath,
        },
      },
    );

    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("expired browser evaluation IDs recover to a fresh start instead of trapping the user", async () => {
  const response = await worker.fetch(
    new Request("https://evaluate.onceexec.test/"),
    pageEnv(),
  );

  const page = await response.text();
  assert.match(page, /body\.error==="evaluation_expired"/);
  assert.match(page, /localStorage\.removeItem\("once_evaluation_id"\)/);
  assert.match(page, /button\.textContent="Start new evaluation"/);
});
