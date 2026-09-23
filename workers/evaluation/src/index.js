const ENTITLEMENT_POLL_ATTEMPTS = 32;
const ENTITLEMENT_POLL_DELAY_MS = 250;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function enabled(env) {
  return String(env.EVALUATION_BYPASS_ENABLED || "")
    .trim()
    .toLowerCase() === "true";
}

function validateEvaluationId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id
    : null;
}

function assertConfiguration(env) {
  const stripeKey = String(env.STRIPE_SECRET_KEY || "").trim();

  if (!stripeKey.startsWith("sk_test_") && !stripeKey.startsWith("rk_test_")) {
    throw new Error("evaluation_requires_stripe_test_key");
  }

  if (!env.STRIPE_PRICE_PRO) {
    throw new Error("evaluation_price_missing");
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

async function stripePost(env, path, fields, idempotencyKey) {
  let response;

  try {
    response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": idempotencyKey,
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

async function createOrRecoverEvaluationSubscription(env, evaluationId) {
  const customer = await stripePost(
    env,
    "customers",
    {
      description: "Once frictionless technical evaluation",
      "metadata[once_sandbox]": "true",
      "metadata[once_evaluation]": "true",
      "metadata[once_evaluation_id]": evaluationId,
    },
    `once-evaluation-customer-${evaluationId}`,
  );

  if (!customer?.id || customer.livemode !== false) {
    throw new Error("evaluation_customer_invalid");
  }

  const subscription = await stripePost(
    env,
    "subscriptions",
    {
      customer: customer.id,
      "items[0][price]": env.STRIPE_PRICE_PRO,
      trial_period_days: "1",
      "trial_settings[end_behavior][missing_payment_method]": "cancel",
      "metadata[plan]": "pro",
      "metadata[once_sandbox]": "true",
      "metadata[once_evaluation]": "true",
      "metadata[once_evaluation_id]": evaluationId,
    },
    `once-evaluation-subscription-${evaluationId}`,
  );

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
  const response = await q18TruthStub(env).fetch(
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
  const id = env.SANDBOX_CLAIMS.idFromName(`stripe-customer:${customerId}`);
  const claim = env.SANDBOX_CLAIMS.get(id);
  const response = await claim.fetch(
    new Request("https://sandbox.internal/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customer_id: customerId,
      }),
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
  assertConfiguration(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const evaluationId = validateEvaluationId(body?.evaluation_id);
  if (!evaluationId) {
    return json({ error: "invalid_evaluation_id" }, 400);
  }

  const evaluation = await createOrRecoverEvaluationSubscription(env, evaluationId);
  const entitlement = await waitForEntitlement(env, evaluation.customerId);

  if (!entitlement) {
    return json(
      {
        error: "evaluation_entitlement_pending",
        message: "The Stripe test entitlement is still propagating. Retry in a few seconds with the same evaluation ID.",
      },
      409,
    );
  }

  const key = await issueEvaluationKey(env, evaluation.customerId);

  return json({
    activated: true,
    mode: "frictionless_stripe_test_trial",
    checkout_required: false,
    card_required: false,
    trial_duration_hours: 24,
    expires_automatically: true,
    plan: key.plan,
    monthly_limit: key.monthly_limit,
    api_key: key.api_key,
    key_id: key.key_id,
    warning: key.warning,
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Once technical evaluation</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#05090e;color:#edf8f3;font:15px/1.6 system-ui,sans-serif}main{width:min(760px,calc(100% - 36px));margin:0 auto;padding:72px 0}.mark{color:#39f0a0;font-weight:850;letter-spacing:.08em}h1{font-size:clamp(38px,7vw,58px);line-height:1;margin:.25em 0}.muted{color:#8da0ad}.card{margin-top:30px;padding:28px;border:1px solid #1e3340;border-radius:18px;background:#09111a}.note{color:#f1c86c}button{padding:14px 19px;border:0;border-radius:10px;background:#39f0a0;color:#04120b;font-weight:850;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}pre{white-space:pre-wrap;word-break:break-word;padding:16px;border-radius:12px;background:#03070a;color:#b9dccb}a{color:#44d0ff}
</style>
</head>
<body>
<main>
<div class="mark">1× ONCE / TECHNICAL EVALUATION</div>
<h1>Try Once without checkout.</h1>
<p class="muted">No card and no Stripe Checkout screen. When enabled by the operator, this creates a one-day Stripe test-mode trial behind the scenes, then uses the same Once entitlement and API-key path as the normal sandbox.</p>
<div class="card">
<button id="activate">Start technical evaluation</button>
<p id="status" class="muted">Test mode only. Nothing is charged.</p>
<pre id="result" hidden></pre>
</div>
<p class="note">The API key is displayed once. Store it securely if you continue the evaluation.</p>
</main>
<script>
const button=document.getElementById("activate");
const status=document.getElementById("status");
const result=document.getElementById("result");
let evaluationId=localStorage.getItem("once_evaluation_id");
if(!evaluationId){evaluationId=crypto.randomUUID();localStorage.setItem("once_evaluation_id",evaluationId)}
button.addEventListener("click",async()=>{
  button.disabled=true;
  status.textContent="Creating test evaluation entitlement…";
  result.hidden=true;
  try{
    const response=await fetch("/api/evaluate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({evaluation_id:evaluationId})});
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
  async fetch(request, env) {
    if (!enabled(env)) {
      return json({ error: "not_found" }, 404);
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      try {
        assertConfiguration(env);
      } catch (error) {
        return html(`<h1>Evaluation unavailable</h1><p>${String(error?.message || "configuration_error")}</p>`, 503);
      }
      return html(PAGE);
    }

    if (request.method === "POST" && url.pathname === "/api/evaluate") {
      try {
        return await activateEvaluation(request, env);
      } catch (error) {
        return json({ error: String(error?.message || "evaluation_activation_failed") }, 502);
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        service: "once-evaluation-bypass",
        status: "online",
        enabled: true,
        stripe_mode: "test_required",
      });
    }

    return json({ error: "not_found" }, 404);
  },
};
