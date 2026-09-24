import {
  assertAdmissionConfiguration,
  enforceEvaluationAdmission,
} from "./admission.js";
import { WINDOWS_INSTALLER } from "./windows-installer.js";

export { EvaluationAdmission } from "./admission.js";

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

function attachment(body, filename, contentType = "application/octet-stream") {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function enabled(env) {
  return String(env.PUBLIC_EVALUATION_ENABLED || "")
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

  assertAdmissionConfiguration(env);
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

  const admissionDenied = await enforceEvaluationAdmission(request, env, evaluationId);
  if (admissionDenied) {
    return admissionDenied;
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
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#05090e;color:#edf8f3;font:15px/1.6 system-ui,sans-serif}main{width:min(820px,calc(100% - 36px));margin:0 auto;padding:72px 0}.mark{color:#39f0a0;font-weight:850;letter-spacing:.08em}h1{font-size:clamp(38px,7vw,58px);line-height:1;margin:.25em 0}h2{font-size:21px;margin:28px 0 8px}.muted{color:#8da0ad}.card{margin-top:30px;padding:28px;border:1px solid #1e3340;border-radius:18px;background:#09111a}.note{color:#f1c86c}.success{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid #246c50;border-radius:999px;background:#0d2b20;color:#79f2b7;font-weight:800}.step{margin-top:24px;padding-top:20px;border-top:1px solid #172a35}.copyrow{display:flex;gap:10px;align-items:stretch;margin:10px 0}.copyvalue{flex:1;display:flex;align-items:center;min-width:0;padding:13px 14px;border:1px solid #1e3340;border-radius:10px;background:#03070a;color:#b9dccb;font:14px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.primary,.copybtn,.installbtn{padding:13px 17px;border:0;border-radius:10px;background:#39f0a0;color:#04120b;font-weight:850;cursor:pointer}.copybtn{white-space:nowrap;background:#153344;color:#dff8ed;border:1px solid #285268}.installbtn{font-size:16px;padding:16px 20px;width:100%;margin-top:10px}.primary:disabled,.copybtn:disabled,.installbtn:disabled{opacity:.55;cursor:not-allowed}.warning{padding:12px 14px;border:1px solid #5f5027;border-radius:10px;background:#1a170d;color:#f1c86c}.done{margin-top:26px;padding:18px;border:1px solid #246c50;border-radius:12px;background:#091b15}.small{font-size:13px}.numbered{margin:12px 0 0;padding-left:22px}.numbered li{margin:8px 0}details{margin-top:24px;padding:14px;border:1px solid #1e3340;border-radius:12px;background:#071018}summary{cursor:pointer;font-weight:750}a{color:#44d0ff}@media(max-width:620px){.copyrow{flex-direction:column}.copybtn{width:100%}}
</style>
</head>
<body>
<main>
<div class="mark">1× ONCE / TECHNICAL EVALUATION</div>
<h1>Try Once without checkout.</h1>
<p class="muted">No card and no Stripe Checkout screen. This creates a one-day Stripe test-mode trial behind the scenes, then uses the normal Once entitlement and API-key path. Admission limits protect the evaluation service from automated abuse.</p>
<div class="card">
<button id="activate" class="primary">Start technical evaluation</button>
<p id="status" class="muted">Test mode only. Nothing is charged.</p>

<div id="result" hidden>
  <div class="success">✓ Evaluation active</div>
  <p><strong>Your Once evaluation is ready.</strong> The easy Windows setup below is designed so you do not need to know PowerShell, npm, or which commands to type.</p>

  <div class="step">
    <h2>Step 1 — Your API key</h2>
    <p>This box contains <strong>only your API key</strong>. Nothing else is mixed into it.</p>
    <div class="copyrow">
      <code id="apiKey" class="copyvalue"></code>
      <button id="copyApiKey" class="copybtn" type="button">Copy API key</button>
    </div>
    <p class="warning small">Your key starts with <strong>once_test_</strong>. It is shown once. Keep this page open until setup is finished.</p>
  </div>

  <div class="step">
    <h2>Step 2 — Let Once install itself</h2>
    <p>On Windows, first click <strong>Copy API key</strong> above. Then click the button below to download the Once setup launcher. The launcher reads the key from your clipboard, so you do not have to paste commands into PowerShell.</p>
    <button id="installWindows" class="installbtn" type="button">Download OnceSetup</button>
    <p id="installStatus" class="muted small">Automatic installer: Windows + Node.js 18 or newer.</p>
  </div>

  <div class="step">
    <h2>Step 3 — Open the downloaded setup file</h2>
    <ol class="numbered">
      <li>Open your browser's Downloads list.</li>
      <li>Open <strong>OnceSetup.cmd</strong>.</li>
      <li>If Windows asks whether you want to run it, confirm that you do.</li>
      <li>Choose <strong>Yes</strong> for a safe demo project (recommended for your first try), or <strong>No</strong> to choose one of your existing Node.js projects.</li>
      <li>Confirm the final setup screen. Once performs the installation, saves the key to <code>.env</code>, protects it with <code>.gitignore</code>, and verifies the connection.</li>
    </ol>
    <p class="muted small">The browser cannot silently run programs on your computer. Opening the downloaded setup file is the one Windows security step we deliberately do not bypass.</p>
  </div>

  <div class="done">
    <strong>What the automatic setup does for you</strong>
    <p>✓ checks your Once key<br>✓ checks Node.js<br>✓ installs <code>@once-agent/sdk</code><br>✓ saves the key to <code>.env</code><br>✓ adds <code>.env</code> to <code>.gitignore</code><br>✓ verifies the Once API connection</p>
    <p>If you choose the recommended demo, it also performs a real Once safety test: the first action executes, the retry is suppressed, and side effects stay at 1.</p>
    <p class="muted small">Your technical evaluation lasts 24 hours. No card is required and nothing will be charged.</p>
  </div>

  <details>
    <summary>Manual setup / Mac / Linux</summary>
    <p>If you are not using the Windows installer, open a terminal inside your project and run:</p>
    <div class="copyrow">
      <code id="installCommand" class="copyvalue">npm install @once-agent/sdk</code>
      <button id="copyInstall" class="copybtn" type="button">Copy command</button>
    </div>
    <div class="copyrow">
      <code id="setupCommand" class="copyvalue">npx once setup .</code>
      <button id="copySetup" class="copybtn" type="button">Copy command</button>
    </div>
    <p class="small muted">When setup asks for a key, paste only the value beginning with <code>once_test_</code>.</p>
  </details>
</div>
</div>
<p class="note">The API key is displayed once. Store it securely if you continue the evaluation.</p>
</main>
<script>
const button=document.getElementById("activate");
const status=document.getElementById("status");
const result=document.getElementById("result");
const apiKey=document.getElementById("apiKey");
const copyApiKey=document.getElementById("copyApiKey");
const installWindows=document.getElementById("installWindows");
const installStatus=document.getElementById("installStatus");
const copyInstall=document.getElementById("copyInstall");
const copySetup=document.getElementById("copySetup");
const installCommand=document.getElementById("installCommand");
const setupCommand=document.getElementById("setupCommand");
let evaluationId=localStorage.getItem("once_evaluation_id");
if(!evaluationId){evaluationId=crypto.randomUUID();localStorage.setItem("once_evaluation_id",evaluationId)}

async function copyText(value,control,successLabel){
  const original=control.textContent;
  try{
    await navigator.clipboard.writeText(value);
    control.textContent=successLabel;
    setTimeout(()=>{control.textContent=original},1600);
    return true;
  }catch{
    control.textContent="Copy failed — select the text";
    setTimeout(()=>{control.textContent=original},2200);
    return false;
  }
}

copyApiKey.addEventListener("click",()=>copyText(apiKey.textContent,copyApiKey,"Copied ✓"));
copyInstall.addEventListener("click",()=>copyText(installCommand.textContent,copyInstall,"Copied ✓"));
copySetup.addEventListener("click",()=>copyText(setupCommand.textContent,copySetup,"Copied ✓"));

installWindows.addEventListener("click",async()=>{
  const key=apiKey.textContent.trim();
  if(!key.startsWith("once_test_")){
    installStatus.textContent="Your API key is not available. Start the evaluation again.";
    return;
  }

  installWindows.disabled=true;
  installStatus.textContent="Preparing OnceSetup…";

  const link=document.createElement("a");
  link.href="/install/windows.cmd";
  link.download="OnceSetup.cmd";
  document.body.appendChild(link);
  link.click();
  link.remove();

  installStatus.textContent="OnceSetup.cmd downloaded. Open it from your Downloads list and follow the buttons. If setup says the key is missing, click Copy API key above and run OnceSetup again.";
  installWindows.textContent="Download OnceSetup again";
  installWindows.disabled=false;
});

button.addEventListener("click",async()=>{
  button.disabled=true;
  status.textContent="Creating your test evaluation…";
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
      if(body.error==="evaluation_expired"){
        localStorage.removeItem("once_evaluation_id");
        evaluationId=crypto.randomUUID();
        localStorage.setItem("once_evaluation_id",evaluationId);
        status.textContent="Your previous evaluation ID expired. A new evaluation is ready to start.";
        button.textContent="Start new evaluation";
        button.disabled=false;
        return;
      }
      if(body.error==="evaluation_rate_limited"||body.error==="evaluation_capacity_reached"){
        status.textContent=body.message||"Evaluation capacity is temporarily limited. Try again later.";
        button.disabled=false;
        return;
      }
      throw new Error(body.error||"evaluation_failed");
    }
    if(typeof body.api_key!=="string"||!body.api_key.startsWith("once_test_")){
      throw new Error("evaluation_key_invalid");
    }
    apiKey.textContent=body.api_key;
    status.textContent="Evaluation activated. Use the automatic installer below.";
    button.hidden=true;
    result.hidden=false;
    installWindows.focus();
  }catch(error){
    status.textContent="Activation failed: "+error.message;
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

    if (request.method === "GET" && url.pathname === "/install/windows.cmd") {
      return attachment(WINDOWS_INSTALLER, "OnceSetup.cmd", "application/octet-stream");
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
        service: "once-public-evaluation",
        status: "online",
        enabled: true,
        stripe_mode: "test_required",
        admission_control: "durable_object",
        windows_installer: "available",
      });
    }

    return json({ error: "not_found" }, 404);
  },
};
