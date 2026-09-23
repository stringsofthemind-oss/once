import test from "node:test";
import assert from "node:assert/strict";
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
  const response = await worker.fetch(
    new Request("https://evaluate.onceexec.test/install/windows.cmd"),
    pageEnv(),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="OnceSetup.cmd"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const installer = await response.text();
  assert.match(installer, /^@echo off/);
  assert.match(installer, /#__ONCE_POWERSHELL__#/);
  assert.match(installer, /Clipboard.*GetText/);
  assert.match(installer, /once_test_/);
  assert.match(installer, /npm install @once-agent\/sdk/);
  assert.match(installer, /Once Evaluation Demo/);
  assert.match(installer, /api\.onceexec\.com\/v1\/truth/);
  assert.match(installer, /retry was suppressed/);

  assert.doesNotMatch(installer, /sk_test_/);
  assert.doesNotMatch(installer, /ONCE_API_KEY=once_test_/);
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
