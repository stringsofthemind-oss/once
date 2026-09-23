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

test("activated onboarding isolates the API key from install commands and gives explicit next steps", async () => {
  const response = await worker.fetch(
    new Request("https://evaluate.onceexec.test/"),
    pageEnv(),
  );

  assert.equal(response.status, 200);
  const page = await response.text();

  assert.match(page, /Step 1 — Copy your API key/);
  assert.match(page, /Step 2 — Open your project terminal/);
  assert.match(page, /Step 3 — Install Once/);
  assert.match(page, /Step 4 — Connect this project to Once/);

  assert.match(page, /<code id="apiKey" class="copyvalue"><\/code>/);
  assert.match(page, /id="copyApiKey"[^>]*>Copy API key<\/button>/);
  assert.match(page, /apiKey\.textContent=body\.api_key/);
  assert.doesNotMatch(page, /result\.textContent=/);

  assert.match(page, /<code id="installCommand"[^>]*>npm install @once-agent\/sdk<\/code>/);
  assert.match(page, /<code id="setupCommand"[^>]*>npx once setup \.<\/code>/);
  assert.match(page, /When setup asks for your Once API key, paste <strong>only the key from Step 1<\/strong>/);

  assert.match(page, /button\.hidden=true/);
  assert.match(page, /✓ Evaluation active/);
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
