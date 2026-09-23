import baseWorker, {
  SandboxClaim,
  SandboxDemoEffect,
} from "./index.js";

export { SandboxClaim, SandboxDemoEffect };

const EVALUATION_COOKIE = "once_eval_customer";
const EVALUATION_MAX_AGE_SECONDS = 24 * 60 * 60;
const ENTITLEMENT_POLL_ATTEMPTS = 32;
const ENTITLEMENT_POLL_DELAY_MS = 250;

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function evaluationEnabled(env) {
  return String(env.EVALUATION_BYPASS_ENABLED || "")
    .trim()
    .toLowerCase() === "true";
}

function assertEvaluationConfiguration(env) {
  const stripeKey = String(env.STRIPE_SECRET_KEY || "").trim();

  if (!stripeKey.startsWith("sk_test_") && !stripeKey.startsWith("rk_test_")) {
    throw new Error("evaluation_requires_stripe_test_key");
  }

  if (!env.STRIPE_PRICE_PRO) {
    throw new Error("evaluation_price_missing");
  }

  if (!env.SANDBOX_SESSION_SECRET) {
    throw new Error("evaluation_session_secret_missing");
  }

  if (!env.Q18_TRUTH || !env.SANDBOX_CLAIMS) {
    throw new Error("evaluation_runtime_binding_missing");
  }
}

function stripeForm(fields) {
  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      form.set(key, String(value));
    }
  }

  return form;
}

async function stripePost(env, path, fields) {
  let response;

  try {
    response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: stripeForm(fields).toString(),
    });
  } catch {
    throw new Error("evaluation_stripe_network_error");
  }

  let body;

  try {
    body = await response.json();
  } catch {
    throw new Error("evaluation_stripe_invalid_response");
  }

  if (!response.ok) {
    const code = String(body?.error?.code || body?.error?.type || "stripe_error");
    throw new Error(`evaluation_stripe_${code}`);
  }

  return body;
}

async function hmacHex(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");

    if (separator < 0) continue;
    if (trimmed.slice(0, separator) !== name) continue;

    return trimmed.slice(separator + 1);
  }

  return null;
}

async function createEvaluationCookie(request, env, customerId) {
  const expiresAt = Math.floor(Date.now() / 1000) + EVALUATION_MAX_AGE_SECONDS;
  const payload = `${customerId}|${expiresAt}`;
  const signature = await hmacHex(
    env.SANDBOX_SESSION_SECRET,
    `evaluation-cookie-v1|${payload}`,
  );
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";

  return `${EVALUATION_COOKIE}=${customerId}.${expiresAt}.${signature}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${EVALUATION_MAX_AGE_SECONDS}`;
}

async function readEvaluationCustomer(request, env) {
  const raw = readCookie(request, EVALUATION_COOKIE);
  if (!raw) return null;

  const match = raw.match(/^(cus_[A-Za-z0-9]+)\.(\d+)\.([0-9a-f]{64})$/i);
  if (!match) return null;

  const customerId = match[1];
  const expiresAt = Number(match[2]);
  const suppliedSignature = match[3].toLowerCase();

  if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return null;
  }

  const expectedSignature = await hmacHex(
    env.SANDBOX_SESSION_SECRET,
    `evaluation-cookie-v1|${customerId}|${expiresAt}`,
  );

  if (suppliedSignature.length !== expectedSignature.length) return null;

  let difference = 0;
  for (let index = 0; index < suppliedSignature.length; index++) {
    difference |= suppliedSignature.charCodeAt(index) ^ expectedSignature.charCodeAt(index);
  }

  return difference === 0 ? customerId : null;
}

async function createEvaluationSubscription(env) {
  const evaluationId = crypto.randomUUID();

  const customer = await stripePost(env, "customers", {
    description: "Once frictionless technical evaluation",
    "metadata[once_sandbox]": "true",
    "metadata[once_evaluation]": "true",
    "metadata[once_evaluation_id]": evaluationId,
  });

  if (!customer?.id || customer.livemode !== false) {
    throw new Error("evaluation_customer_invalid");
  }

  const subscription = await stripePost(env, "subscriptions", {
    customer: customer.id,
    "items[0][price]": env.STRIPE_PRICE_PRO,
    trial_period_days: "1",
    "trial_settings[end_behavior][missing_payment_method]": "cancel",
    "metadata[plan]": "pro",
    "metadata[once_sandbox]": "true",
    "metadata[once_evaluation]": "true",
    "metadata[once_evaluation_id]": evaluationId,
  });

  if (
    !subscription?.id ||
    subscription.livemode !== false ||
    !new Set(["trialing", "active"]).has(String(subscription.status || ""))
  ) {
    throw new Error("evaluation_subscription_invalid");
  }

  return {
    customerId: customer.id,
    subscriptionId: subscription.id,
  };
}

function q18TruthStub(env) {
  const id = env.Q18_TRUTH.idFromName("once-q18-authoritative-ledger-v1");
  return env.Q18_TRUTH.get(id);
}

async function readEntitlement(env, customerId) {
  const truth = q18TruthStub(env);
  const response = await truth.fetch(
    new Request(
      `https://q18.internal/stripe/entitlement/${encodeURIComponent(customerId)}`,
      { method: "GET" },
    ),
  );

  if (response.status === 404) return null;
  if (!response.ok) throw new Error("evaluation_entitlement_check_failed");

  return response.json();
}

async function waitForEntitlement(env, customerId) {
  for (let attempt = 0; attempt < ENTITLEMENT_POLL_ATTEMPTS; attempt++) {
    const entitlement = await readEntitlement(env, customerId);

    if (
      entitlement &&
      new Set(["active", "trialing"]).has(String(entitlement.status || ""))
    ) {
      return entitlement;
    }

    await new Promise((resolve) => setTimeout(resolve, ENTITLEMENT_POLL_DELAY_MS));
  }

  return null;
}

async function issueEvaluationKey(env, customerId) {
  const claimId = env.SANDBOX_CLAIMS.idFromName(`stripe-customer:${customerId}`);
  const claim = env.SANDBOX_CLAIMS.get(claimId);
  const response = await claim.fetch(
    new Request("https://sandbox.internal/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_id: customerId }),
    }),
  );

  let body;

  try {
    body = await response.json();
  } catch {
    throw new Error("evaluation_key_invalid_response");
  }

  if (!response.ok) {
    throw new Error(String(body?.error || "evaluation_key_issue_failed"));
  }

  if (!body?.api_key) {
    throw new Error("evaluation_key_already_issued");
  }

  return body;
}

async function activateEvaluation(request, env) {
  assertEvaluationConfiguration(env);

  let customerId = await readEvaluationCustomer(request, env);
  let created = false;

  if (!customerId) {
    const evaluation = await createEvaluationSubscription(env);
    customerId = evaluation.customerId;
    created = true;
  }

  const entitlement = await waitForEntitlement(env, customerId);

  if (!entitlement) {
    const cookie = await createEvaluationCookie(request, env, customerId);
    return json(
      {
        error: "evaluation_entitlement_pending",
        message: "The Stripe test entitlement is still propagating. Retry activation in a few seconds; no new checkout is required.",
      },
      409,
      { "set-cookie": cookie },
    );
  }

  const key = await issueEvaluationKey(env, customerId);
  const cookie = await createEvaluationCookie(request, env, customerId);

  return json(
    {
      activated: true,
      mode: "frictionless_stripe_test_trial",
      checkout_required: false,
      card_required: false,
      expires_automatically: true,
      plan: key.plan,
      monthly_limit: key.monthly_limit,
      api_key: key.api_key,
      key_id: key.key_id,
      created_new_test_subscription: created,
      warning: key.warning,
    },
    200,
    { "set-cookie": cookie },
  );
}

const EVALUATION_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evaluate Once — no checkout</title>
<style>
  body{margin:0;background:#05090e;color:#eef7f3;font:15px/1.6 system-ui,sans-serif}
  main{width:min(760px,calc(100% - 36px));margin:0 auto;padding:72px 0}
  .mark{color:#39f0a0;font-weight:800}.card{margin-top:28px;padding:28px;border:1px solid #1f3440;border-radius:18px;background:#09111a}
  h1{font-size:44px;line-height:1;margin:.2em 0}.muted{color:#8ca0ad}.note{color:#f5c96a}
  button{padding:13px 18px;border:0;border-radius:10px;background:#39f0a0;color:#04120b;font-weight:800;cursor:pointer}
  button:disabled{opacity:.55;cursor:not-allowed}pre{white-space:pre-wrap;word-break:break-word;padding:16px;border-radius:12px;background:#03070a;color:#b8d9ca}
  a{color:#44d0ff}
</style>
</head>
<body>
<main>
  <div class="mark">1× ONCE / TECHNICAL EVALUATION</div>
  <h1>Try Once without checkout.</h1>
  <p class="muted">No card and no Stripe Checkout screen. This creates a one-day Stripe test-mode trial behind the scenes, then uses the same entitlement and API-key path as the existing sandbox.</p>
  <div class="card">
    <button id="activate">Start technical evaluation</button>
    <p id="status" class="muted">Nothing is charged. Test mode only.</p>
    <pre id="result" hidden></pre>
  </div>
  <p class="note">Evaluation bypass is deliberately feature-gated. It cannot run unless the operator explicitly enables it.</p>
  <p><a href="/">Return to the normal sandbox checkout</a></p>
</main>
<script>
const button=document.getElementById("activate");
const status=document.getElementById("status");
const result=document.getElementById("result");
button.addEventListener("click",async()=>{
  button.disabled=true;
  status.textContent="Creating test evaluation entitlement…";
  result.hidden=true;
  try{
    const response=await fetch("/api/evaluate",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    const body=await response.json();
    if(!response.ok){
      if(body.error==="evaluation_entitlement_pending"){
        status.textContent=body.message;
        button.textContent="Retry activation";
        button.disabled=false;
        return;
      }
      throw new Error(body.error||"evaluation_failed");
    }
    status.textContent="Evaluation activated. Copy the API key now; it is shown once.";
    result.hidden=false;
    result.textContent=`ONCE_API_KEY=${body.api_key}\n\nnpm install @once-agent/sdk\nnpx once setup .`;
    button.textContent="Activated";
  }catch(error){
    status.textContent=`Activation failed: ${error.message}`;
    button.disabled=false;
  }
});
</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!evaluationEnabled(env)) {
      return baseWorker.fetch(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/evaluate") {
      try {
        assertEvaluationConfiguration(env);
      } catch (error) {
        return html(`<h1>Evaluation unavailable</h1><p>${String(error?.message || "configuration_error")}</p>`, 503);
      }

      return html(EVALUATION_PAGE);
    }

    if (request.method === "POST" && url.pathname === "/api/evaluate") {
      try {
        return await activateEvaluation(request, env);
      } catch (error) {
        return json(
          {
            error: String(error?.message || "evaluation_activation_failed"),
          },
          502,
        );
      }
    }

    return baseWorker.fetch(request, env, ctx);
  },
};
