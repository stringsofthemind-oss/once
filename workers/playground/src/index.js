var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/sandbox-demo-provider.js
function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store"
    }
  });
}
__name(json, "json");
var SandboxDemoEffect = class {
  static {
    __name(this, "SandboxDemoEffect");
  }
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }
  fetch(request) {
    const task = this.queue.then(
      () => this.handle(request)
    );
    this.queue = task.catch(() => {
    });
    return task;
  }
  async handle(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/truth") {
      const state2 = await this.ctx.storage.get(
        "state"
      );
      if (!state2) {
        return json({
          provider_executed: false,
          side_effects: 0,
          execute_calls: 0
        });
      }
      return json({
        provider_executed: state2.side_effects > 0,
        side_effects: state2.side_effects,
        execute_calls: state2.execute_calls,
        result: state2.result || null
      });
    }
    if (request.method !== "POST" || url.pathname !== "/execute") {
      return json(
        {
          error: "not_found"
        },
        404
      );
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json(
        {
          error: "invalid_json"
        },
        400
      );
    }
    const operationId = String(
      body?.operation_id || ""
    ).trim();
    if (!operationId) {
      return json(
        {
          error: "operation_id_required"
        },
        400
      );
    }
    const action = body?.action && typeof body.action === "object" ? body.action : {};
    const fault = String(
      action.fault || ""
    ).trim().toLowerCase();
    const previous = await this.ctx.storage.get(
      "state"
    ) || {
      execute_calls: 0,
      side_effects: 0
    };
    const executeCalls = previous.execute_calls + 1;
    const sideEffects = previous.side_effects + 1;
    const result = {
      demo: true,
      message: "Sandbox side effect committed",
      effect_number: sideEffects
    };
    const state = {
      execute_calls: executeCalls,
      side_effects: sideEffects,
      result,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    await this.ctx.storage.put(
      "state",
      state
    );
    if (fault === "commit_then_503" && executeCalls === 1) {
      return json(
        {
          error: "sandbox_commit_then_503",
          provider_executed: true,
          side_effects: sideEffects
        },
        503
      );
    }
    return json({
      provider_executed: true,
      side_effects: sideEffects,
      execute_calls: executeCalls,
      result
    });
  }
};

// src/sandbox-claim.js
function json2(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store"
    }
  });
}
__name(json2, "json");
var SandboxClaim = class {
  static {
    __name(this, "SandboxClaim");
  }
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }
  fetch(request) {
    const task = this.queue.then(
      () => this.handle(request)
    );
    this.queue = task.catch(() => {
    });
    return task;
  }
  async handle(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      const state = await this.ctx.storage.get(
        "claim"
      );
      if (!state) {
        return json2({
          status: "UNCLAIMED"
        });
      }
      return json2({
        status: state.status,
        key_id: state.key_id || null,
        customer_id: state.customer_id || null,
        plan: state.plan || null,
        monthly_limit: state.monthly_limit || null,
        updated_at: state.updated_at || null
      });
    }
    if (request.method !== "POST" || url.pathname !== "/claim") {
      return json2(
        {
          error: "not_found"
        },
        404
      );
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json2(
        {
          error: "invalid_json"
        },
        400
      );
    }
    const customerId = String(
      body?.customer_id || ""
    ).trim();
    if (!customerId) {
      return json2(
        {
          error: "customer_id_required"
        },
        400
      );
    }
    const existing = await this.ctx.storage.get(
      "claim"
    );
    if (existing?.status === "CLAIMED") {
      return json2({
        created: false,
        already_claimed: true,
        status: "CLAIMED",
        key_id: existing.key_id || null,
        customer_id: existing.customer_id,
        plan: existing.plan || null,
        monthly_limit: existing.monthly_limit || null,
        warning: "The raw API key was already shown once and is not recoverable."
      });
    }
    if (existing?.status === "ISSUING" || existing?.status === "AMBIGUOUS") {
      return json2(
        {
          created: false,
          status: existing.status,
          error: "api_key_claim_ambiguous",
          message: "Once will not blindly issue another key because the previous issuance outcome is uncertain."
        },
        409
      );
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await this.ctx.storage.put(
      "claim",
      {
        status: "ISSUING",
        customer_id: customerId,
        updated_at: now
      }
    );
    try {
      const id = this.env.Q18_TRUTH.idFromName(
        "once-q18-authoritative-ledger-v1"
      );
      const stub = this.env.Q18_TRUTH.get(id);
      const response = await stub.fetch(
        new Request(
          "https://q18.internal/admin/api-keys",
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              customer_id: customerId
            })
          }
        )
      );
      let result;
      try {
        result = await response.json();
      } catch {
        await this.ctx.storage.put(
          "claim",
          {
            status: "AMBIGUOUS",
            customer_id: customerId,
            updated_at: (/* @__PURE__ */ new Date()).toISOString()
          }
        );
        return json2(
          {
            error: "api_key_issue_invalid_response",
            status: "AMBIGUOUS"
          },
          502
        );
      }
      if (!response.ok || !result?.api_key || !result?.key_id) {
        await this.ctx.storage.put(
          "claim",
          {
            status: "AMBIGUOUS",
            customer_id: customerId,
            core_status: response.status,
            updated_at: (/* @__PURE__ */ new Date()).toISOString()
          }
        );
        return json2(
          {
            error: "api_key_issue_failed",
            status: "AMBIGUOUS",
            core_status: response.status
          },
          502
        );
      }
      await this.ctx.storage.put(
        "claim",
        {
          status: "CLAIMED",
          key_id: result.key_id,
          customer_id: customerId,
          plan: result.plan || null,
          monthly_limit: result.monthly_limit || null,
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }
      );
      return json2({
        created: true,
        already_claimed: false,
        status: "CLAIMED",
        key_id: result.key_id,
        api_key: result.api_key,
        customer_id: customerId,
        plan: result.plan || null,
        monthly_limit: result.monthly_limit || null,
        warning: "Copy this API key now. It is shown once and is not recoverable."
      });
    } catch {
      await this.ctx.storage.put(
        "claim",
        {
          status: "AMBIGUOUS",
          customer_id: customerId,
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }
      );
      return json2(
        {
          error: "api_key_issue_ambiguous",
          status: "AMBIGUOUS",
          message: "The issuance result is uncertain. Another key will not be issued automatically."
        },
        503
      );
    }
  }
};

// src/index.js
function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
__name(html, "html");
function json3(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}
__name(json3, "json");
var textEncoder = new TextEncoder();
var SANDBOX_COOKIE = "once_sandbox_session";
function bytesToHex(bytes) {
  return Array.from(bytes).map(
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}
__name(bytesToHex, "bytesToHex");
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(value)
  );
  return bytesToHex(
    new Uint8Array(signature)
  );
}
__name(hmacHex, "hmacHex");
function timingSafeTextEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  let diff = left.length ^ right.length;
  const length = Math.max(
    left.length,
    right.length
  );
  for (let i = 0; i < length; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}
__name(timingSafeTextEqual, "timingSafeTextEqual");
function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf("=");
    if (equals < 0) {
      continue;
    }
    const key = trimmed.substring(
      0,
      equals
    );
    if (key !== name) {
      continue;
    }
    return trimmed.substring(
      equals + 1
    );
  }
  return null;
}
__name(readCookie, "readCookie");
function sandboxBrowserOrigin(request, env) {
  const configuredDevOrigin = String(
    env.SANDBOX_DEV_ORIGIN || ""
  ).trim();
  if (configuredDevOrigin) {
    let devUrl;
    try {
      devUrl = new URL(
        configuredDevOrigin
      );
    } catch {
      throw new Error(
        "invalid_sandbox_dev_origin"
      );
    }
    const hostname2 = devUrl.hostname.toLowerCase();
    const isLoopback2 = hostname2 === "127.0.0.1" || hostname2 === "localhost" || hostname2 === "[::1]";
    if (devUrl.protocol !== "http:" || !isLoopback2) {
      throw new Error(
        "invalid_sandbox_dev_origin"
      );
    }
    return {
      origin: devUrl.origin,
      localHttp: true
    };
  }
  const requestUrl = new URL(
    request.url
  );
  if (requestUrl.protocol === "https:") {
    return {
      origin: requestUrl.origin,
      localHttp: false
    };
  }
  const hostname = requestUrl.hostname.toLowerCase();
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  if (!isLoopback) {
    throw new Error(
      "sandbox_cookie_requires_https"
    );
  }
  return {
    origin: requestUrl.origin,
    localHttp: true
  };
}
__name(sandboxBrowserOrigin, "sandboxBrowserOrigin");
async function createSandboxCookie(request, env, sandboxSessionId) {
  if (!env.SANDBOX_SESSION_SECRET) {
    throw new Error(
      "sandbox_session_secret_missing"
    );
  }
  const signature = await hmacHex(
    env.SANDBOX_SESSION_SECRET,
    sandboxSessionId
  );
  const browser = sandboxBrowserOrigin(
    request,
    env
  );
  const secureAttribute = browser.localHttp ? "" : "; Secure";
  return SANDBOX_COOKIE + "=" + sandboxSessionId + "." + signature + "; Path=/; HttpOnly" + secureAttribute + "; SameSite=Lax; Max-Age=1800";
}
__name(createSandboxCookie, "createSandboxCookie");
async function verifySandboxCookie(request, env) {
  if (!env.SANDBOX_SESSION_SECRET) {
    return {
      ok: false,
      error: "sandbox_session_secret_missing"
    };
  }
  const raw = readCookie(
    request,
    SANDBOX_COOKIE
  );
  if (!raw) {
    return {
      ok: false,
      error: "sandbox_session_cookie_missing"
    };
  }
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) {
    return {
      ok: false,
      error: "sandbox_session_cookie_invalid"
    };
  }
  const sessionId = raw.substring(
    0,
    separator
  );
  const suppliedSignature = raw.substring(
    separator + 1
  );
  if (!/^[0-9a-f-]{36}$/i.test(
    sessionId
  )) {
    return {
      ok: false,
      error: "sandbox_session_cookie_invalid"
    };
  }
  const expectedSignature = await hmacHex(
    env.SANDBOX_SESSION_SECRET,
    sessionId
  );
  if (!timingSafeTextEqual(
    suppliedSignature,
    expectedSignature
  )) {
    return {
      ok: false,
      error: "sandbox_session_cookie_invalid"
    };
  }
  return {
    ok: true,
    sandboxSessionId: sessionId
  };
}
__name(verifySandboxCookie, "verifySandboxCookie");
async function retrieveStripeSession(env, sessionId) {
  let response;
  try {
    response = await fetch(
      "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(
        sessionId
      ),
      {
        method: "GET",
        headers: {
          authorization: "Bearer " + env.STRIPE_SECRET_KEY
        }
      }
    );
  } catch {
    return {
      ok: false,
      networkError: true
    };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      invalidResponse: true,
      status: response.status
    };
  }
  return {
    ok: response.ok,
    status: response.status,
    body
  };
}
__name(retrieveStripeSession, "retrieveStripeSession");
async function createActivationHandoff(
  request,
  env,
  checkout
) {
  const expiresAt = Math.floor(Date.now() / 1000) + 600;

  const payload = [
    checkout.sandbox_session_id,
    checkout.session_id,
    expiresAt
  ].join("|");

  const signature = await hmacHex(
    env.SANDBOX_SESSION_SECRET,
    "activation-handoff-v1|" + payload
  );

  const browser = sandboxBrowserOrigin(
    request,
    env
  );

  const handoffUrl = new URL(
    "/activate/handoff",
    browser.origin
  );

  handoffUrl.searchParams.set(
    "sandbox_session_id",
    checkout.sandbox_session_id
  );

  handoffUrl.searchParams.set(
    "session_id",
    checkout.session_id
  );

  handoffUrl.searchParams.set(
    "expires",
    String(expiresAt)
  );

  handoffUrl.searchParams.set(
    "signature",
    signature
  );

  return handoffUrl.toString();
}
__name(createActivationHandoff, "createActivationHandoff");

async function handleActivationHandoff(
  request,
  env
) {
  if (
    !env.SANDBOX_SESSION_SECRET ||
    !env.STRIPE_SECRET_KEY
  ) {
    return json3(
      {
        error: "sandbox_handoff_not_configured"
      },
      503
    );
  }

  const url = new URL(request.url);

  const sandboxSessionId = String(
    url.searchParams.get("sandbox_session_id") || ""
  ).trim();

  const sessionId = String(
    url.searchParams.get("session_id") || ""
  ).trim();

  const expiresRaw = String(
    url.searchParams.get("expires") || ""
  ).trim();

  const suppliedSignature = String(
    url.searchParams.get("signature") || ""
  ).trim();

  if (
    !/^[0-9a-f-]{36}$/i.test(sandboxSessionId) ||
    !sessionId ||
    !/^\d+$/.test(expiresRaw) ||
    !/^[0-9a-f]{64}$/i.test(suppliedSignature)
  ) {
    return json3(
      {
        error: "invalid_activation_handoff"
      },
      400
    );
  }

  const expiresAt = Number(expiresRaw);
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < now ||
    expiresAt > now + 600
  ) {
    return json3(
      {
        error: "activation_handoff_expired"
      },
      403
    );
  }

  const payload = [
    sandboxSessionId,
    sessionId,
    expiresRaw
  ].join("|");

  const expectedSignature = await hmacHex(
    env.SANDBOX_SESSION_SECRET,
    "activation-handoff-v1|" + payload
  );

  if (
    !timingSafeTextEqual(
      suppliedSignature,
      expectedSignature
    )
  ) {
    return json3(
      {
        error: "invalid_activation_handoff"
      },
      403
    );
  }

  const stripe = await retrieveStripeSession(
    env,
    sessionId
  );

  if (
    !stripe.ok ||
    !stripe.body
  ) {
    return json3(
      {
        error: "activation_checkout_not_found"
      },
      404
    );
  }

  const stripeSession = stripe.body;

  if (
    stripeSession.client_reference_id !== sandboxSessionId ||
    stripeSession?.metadata?.once_sandbox !== "true" ||
    stripeSession?.metadata?.once_sandbox_session !== sandboxSessionId
  ) {
    return json3(
      {
        error: "activation_handoff_session_mismatch"
      },
      403
    );
  }

  const checkoutUrl =
    typeof stripeSession.url === "string"
      ? stripeSession.url
      : "";

  if (!checkoutUrl) {
    return json3(
      {
        error: "activation_checkout_url_missing"
      },
      409
    );
  }

  const sessionCookie = await createSandboxCookie(
    request,
    env,
    sandboxSessionId
  );

  return new Response(
    null,
    {
      status: 303,
      headers: {
        "location": checkoutUrl,
        "set-cookie": sessionCookie,
        "cache-control": "no-store"
      }
    }
  );
}
__name(handleActivationHandoff, "handleActivationHandoff");
function q18TruthStub(env) {
  const id = env.Q18_TRUTH.idFromName(
    "once-q18-authoritative-ledger-v1"
  );
  return env.Q18_TRUTH.get(
    id
  );
}
__name(q18TruthStub, "q18TruthStub");
function stripeForm(fields) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== void 0 && value !== null) {
      form.set(key, String(value));
    }
  }
  return form;
}
__name(stripeForm, "stripeForm");
function getPlan(env, requestedPlan) {
  const plans = {
    pro: {
      name: "Pro",
      priceId: env.STRIPE_PRICE_PRO,
      displayPrice: "\xA329"
    },
    startup: {
      name: "Startup",
      priceId: env.STRIPE_PRICE_STARTUP,
      displayPrice: "\xA379"
    },
    scale: {
      name: "Scale",
      priceId: env.STRIPE_PRICE_SCALE,
      displayPrice: "\xA3199"
    }
  };
  return plans[requestedPlan] || null;
}
__name(getPlan, "getPlan");
async function createStripeCheckoutSession({
  request,
  env,
  planKey,
  plan
}) {
  if (!env.STRIPE_SECRET_KEY) {
    return {
      ok: false,
      response: json3(
        {
          error: "stripe_sandbox_not_configured"
        },
        503
      )
    };
  }
  if (!plan.priceId) {
    return {
      ok: false,
      response: json3(
        {
          error: "stripe_price_not_configured",
          plan: planKey
        },
        503
      )
    };
  }
  const browser = sandboxBrowserOrigin(
    request,
    env
  );
  const origin = browser.origin;
  const sandboxSessionId = crypto.randomUUID();
  const successUrl = origin + "/success?session_id={CHECKOUT_SESSION_ID}";
  const cancelUrl = origin + "/?checkout=cancelled";
  const form = stripeForm({
    mode: "subscription",
    "line_items[0][price]": plan.priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: sandboxSessionId,
    "metadata[once_sandbox]": "true",
    "metadata[once_sandbox_plan]": planKey,
    "metadata[once_sandbox_session]": sandboxSessionId,
    "subscription_data[metadata][plan]": planKey,
    "subscription_data[metadata][once_sandbox]": "true",
    "subscription_data[metadata][once_sandbox_session]": sandboxSessionId
  });
  let stripeResponse;
  try {
    stripeResponse = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + env.STRIPE_SECRET_KEY,
          "content-type": "application/x-www-form-urlencoded"
        },
        body: form.toString()
      }
    );
  } catch {
    return {
      ok: false,
      response: json3(
        {
          error: "stripe_network_error"
        },
        502
      )
    };
  }
  let stripeBody;
  try {
    stripeBody = await stripeResponse.json();
  } catch {
    return {
      ok: false,
      response: json3(
        {
          error: "stripe_invalid_response"
        },
        502
      )
    };
  }
  if (!stripeResponse.ok) {
    return {
      ok: false,
      response: json3(
        {
          error: "stripe_checkout_failed",
          stripe_type: stripeBody?.error?.type || null,
          stripe_code: stripeBody?.error?.code || null
        },
        502
      )
    };
  }
  const checkoutUrl = typeof stripeBody?.url === "string" ? stripeBody.url : "";
  const checkoutSessionId = typeof stripeBody?.id === "string" ? stripeBody.id : "";
  if (!checkoutUrl || !checkoutSessionId) {
    return {
      ok: false,
      response: json3(
        {
          error: "stripe_checkout_incomplete_response"
        },
        502
      )
    };
  }
  return {
    ok: true,
    checkout: {
      url: checkoutUrl,
      session_id: checkoutSessionId,
      sandbox_session_id: sandboxSessionId,
      plan: planKey
    }
  };
}
__name(createStripeCheckoutSession, "createStripeCheckoutSession");
var PAGE = `<!doctype html>
<html lang="en">

<head>
<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<meta
  name="description"
  content="Once Playground \u2014 safely test consequential AI-agent retries."
>

<title>Once Playground</title>

<style>
:root{
  --bg:#05070b;
  --bg2:#081019;
  --panel:rgba(10,17,26,.82);
  --panel2:rgba(13,23,35,.86);
  --line:rgba(157,189,218,.14);
  --line2:rgba(157,189,218,.25);
  --text:#f5f8fb;
  --muted:#8ea0b0;
  --green:#39f0a0;
  --cyan:#43d7ff;
  --red:#ff6878;
  --amber:#ffba62;
  --shadow:0 30px 100px rgba(0,0,0,.46);
  color-scheme:dark;
}

*{
  box-sizing:border-box;
}

html{
  scroll-behavior:smooth;
}

body{
  margin:0;
  min-height:100vh;
  color:var(--text);
  background:#05070b;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  overflow-x:hidden;
}

body::before{
  content:"";
  position:fixed;
  inset:0;
  pointer-events:none;
  z-index:-1;
  opacity:.15;
  background-image:
    linear-gradient(
      rgba(255,255,255,.025) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      rgba(255,255,255,.02) 1px,
      transparent 1px
    );
  background-size:44px 44px;
}

a{
  color:inherit;
  text-decoration:none;
}

button{
  font:inherit;
}

.shell{
  position:relative;
  z-index:1;
}

.topbar{
  position:fixed;
  z-index:100;
  top:0;
  left:0;
  right:0;
  height:72px;
  border-bottom:1px solid rgba(255,255,255,.055);
  background:rgba(5,7,11,.78);
  backdrop-filter:blur(18px);
}

.topbar-inner{
  width:min(1320px,calc(100% - 40px));
  height:100%;
  margin:auto;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:20px;
}

.brand{
  display:flex;
  align-items:center;
  gap:11px;
  font-size:19px;
  font-weight:780;
  letter-spacing:-.035em;
}

.brand-mark{
  width:38px;
  height:38px;
  display:grid;
  place-items:center;
  border:1px solid rgba(99,229,255,.28);
  border-radius:12px;
  background:
    linear-gradient(
      145deg,
      rgba(67,215,255,.18),
      rgba(57,240,160,.12)
    );
  color:var(--green);
  font:
    800 12px
    ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}

.top-status{
  display:flex;
  align-items:center;
  gap:8px;
  padding:7px 11px;
  border:1px solid var(--line);
  border-radius:999px;
  color:#8ea1b0;
  font-size:9px;
  letter-spacing:.10em;
}

.top-status i{
  width:7px;
  height:7px;
  border-radius:50%;
  background:var(--green);
  box-shadow:0 0 14px var(--green);
}

.hero{
  width:min(1320px,calc(100% - 40px));
  min-height:760px;
  margin:auto;
  padding:128px 0 40px;
  display:grid;
  grid-template-columns:1fr .94fr;
  gap:38px;
  align-items:center;
}

.eyebrow{
  display:flex;
  align-items:center;
  gap:10px;
  color:#97aab7;
  font:
    750 9px
    ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  letter-spacing:.15em;
}

.eyebrow i{
  width:7px;
  height:7px;
  border-radius:50%;
  background:var(--green);
  box-shadow:0 0 15px var(--green);
}

.hero h1{
  margin:23px 0 24px;
  font-size:clamp(52px,6vw,88px);
  line-height:.91;
  letter-spacing:-.065em;
}

.hero h1 em{
  color:var(--green);
  font-style:normal;
}

.hero-copy{
  max-width:720px;
}

.hero-copy > p{
  max-width:680px;
  color:#98a9b6;
  font-size:16px;
  line-height:1.7;
}

.visual{
  position:relative;
  min-height:590px;
  overflow:hidden;
  border:1px solid var(--line2);
  border-radius:30px;
  box-shadow:var(--shadow);
  background:
    linear-gradient(
      180deg,
      rgba(4,8,13,.05),
      rgba(4,8,13,.28) 40%,
      rgba(4,8,13,.93)
    ),
    url("https://images.pexels.com/photos/17323801/pexels-photo-17323801/free-photo-of-network-rack.jpeg?auto=compress&cs=tinysrgb&w=2200")
    center/cover no-repeat;
}

.visual::after{
  content:"";
  position:absolute;
  inset:0;
  background:
    radial-gradient(
      circle at 70% 22%,
      rgba(67,215,255,.14),
      transparent 34%
    );
}

.visual-top{
  position:absolute;
  z-index:3;
  top:19px;
  left:19px;
  right:19px;
  display:flex;
  justify-content:space-between;
  color:#a0b4c0;
  font:
    700 8px
    ui-monospace,
    monospace;
  letter-spacing:.15em;
}

.live{
  color:var(--green);
}

.scan{
  position:absolute;
  z-index:3;
  left:0;
  right:0;
  top:22%;
  height:1px;
  background:
    linear-gradient(
      90deg,
      transparent,
      var(--cyan),
      transparent
    );
  box-shadow:0 0 14px rgba(67,215,255,.6);
  animation:scan 7s ease-in-out infinite;
}

@keyframes scan{
  0%,100%{top:18%;opacity:.25}
  50%{top:72%;opacity:.85}
}

.hud{
  position:absolute;
  z-index:4;
  left:20px;
  right:20px;
  bottom:20px;
  display:grid;
  grid-template-columns:repeat(2,1fr);
  gap:9px;
}

.hud-item{
  padding:15px;
  border:1px solid rgba(189,223,244,.17);
  border-radius:15px;
  background:rgba(5,11,18,.72);
  backdrop-filter:blur(18px);
}

.hud-item small,
.metric small,
.telemetry-label{
  display:block;
  color:#718695;
  font:
    720 8px
    ui-monospace,
    monospace;
  letter-spacing:.14em;
}

.hud-item strong{
  display:block;
  margin-top:8px;
  font:
    760 19px
    ui-monospace,
    monospace;
}

.green{
  color:var(--green)!important;
}

.cyan{
  color:var(--cyan)!important;
}

.red{
  color:var(--red)!important;
}

.section{
  position:relative;
  width:min(1320px,calc(100% - 40px));
  margin:28px auto;
  padding:64px 42px;
  overflow:hidden;
  border:1px solid var(--line);
  border-radius:30px;
  background:
    linear-gradient(
      90deg,
      rgba(5,9,14,.96),
      rgba(5,9,14,.88)
    );
  box-shadow:0 30px 90px rgba(0,0,0,.20);
}

.scene{
  isolation:isolate;
}

.scene::before{
  content:"";
  position:absolute;
  z-index:-2;
  inset:0;
  background-image:var(--scene);
  background-size:cover;
  background-position:center;
  filter:saturate(.65) contrast(1.08);
  opacity:.34;
}

.scene::after{
  content:"";
  position:absolute;
  z-index:-1;
  inset:0;
  background:
    radial-gradient(
      700px 430px at 80% 15%,
      rgba(67,215,255,.07),
      transparent 60%
    ),
    linear-gradient(
      90deg,
      rgba(5,9,14,.98),
      rgba(5,9,14,.86) 55%,
      rgba(5,9,14,.72)
    );
}

.section-head{
  display:grid;
  grid-template-columns:170px 1fr;
  gap:28px;
  margin-bottom:42px;
}

.chapter{
  color:var(--cyan);
  font:
    750 10px
    ui-monospace,
    monospace;
  letter-spacing:.14em;
}

.section h2{
  max-width:900px;
  margin:0 0 13px;
  font-size:clamp(37px,4.7vw,64px);
  line-height:.98;
  letter-spacing:-.052em;
}

.section-head p{
  max-width:760px;
  color:#8ea0ae;
  line-height:1.65;
  font-size:13px;
}

.plans{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:11px;
}

.plan{
  position:relative;
  min-height:300px;
  padding:22px;
  border:1px solid var(--line);
  border-radius:19px;
  background:
    linear-gradient(
      180deg,
      rgba(14,24,37,.86),
      rgba(7,12,19,.89)
    );
  backdrop-filter:blur(16px);
}

.plan-featured{
  border-color:rgba(57,240,160,.27);
  box-shadow:inset 0 0 40px rgba(57,240,160,.025);
}

.plan-tag{
  color:var(--cyan);
  font:
    700 8px
    ui-monospace,
    monospace;
  letter-spacing:.13em;
}

.plan h3{
  margin:36px 0 5px;
  font-size:23px;
}

.price{
  margin:12px 0 4px;
  color:#f5f8fb;
  font:
    760 37px
    ui-monospace,
    monospace;
  letter-spacing:-.05em;
}

.plan small{
  display:block;
  min-height:48px;
  color:#748896;
  line-height:1.5;
}

button{
  appearance:none;
  cursor:pointer;
  border:1px solid var(--line2);
  border-radius:11px;
  padding:11px 15px;
  background:rgba(255,255,255,.025);
  color:#dce8ef;
  font-size:10px;
  font-weight:800;
  transition:.18s;
}

button:hover:not(:disabled){
  transform:translateY(-1px);
  border-color:rgba(57,240,160,.42);
}

button:disabled{
  cursor:not-allowed;
  opacity:.45;
}

.primary{
  background:var(--green);
  border-color:transparent;
  color:#04120b;
  box-shadow:0 0 28px rgba(57,240,160,.12);
}

.plan button{
  width:100%;
  margin-top:20px;
}

.status{
  margin-top:18px;
  min-height:20px;
  color:#8fa2b1;
  font:
    650 10px
    ui-monospace,
    monospace;
}

.status.error{
  color:var(--red);
}

.flow{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:10px;
}

.flow-step{
  min-height:150px;
  padding:17px;
  border:1px solid var(--line);
  border-radius:15px;
  background:rgba(8,14,22,.78);
}

.flow-step span{
  display:block;
  color:var(--cyan);
  font:
    700 9px
    ui-monospace,
    monospace;
}

.flow-step strong{
  display:block;
  margin:44px 0 6px;
  font-size:13px;
}

.flow-step small{
  color:#758897;
}

.dashboard{
  width:min(1320px,calc(100% - 40px));
  margin:0 auto;
  padding:122px 0 80px;
}

.dashboard-hero{
  position:relative;
  min-height:460px;
  overflow:hidden;
  padding:55px;
  border:1px solid var(--line2);
  border-radius:30px;
  background:
    linear-gradient(
      90deg,
      rgba(5,9,14,.98),
      rgba(5,9,14,.74)
    ),
    url("https://images.pexels.com/photos/5480781/pexels-photo-5480781.jpeg?auto=compress&cs=tinysrgb&w=2200")
    center/cover no-repeat;
  box-shadow:var(--shadow);
}

.dashboard-hero h1{
  max-width:820px;
  margin:24px 0 18px;
  font-size:clamp(48px,6vw,82px);
  line-height:.92;
  letter-spacing:-.06em;
}

.dashboard-hero p{
  max-width:660px;
  color:#97a8b5;
  line-height:1.65;
}

.metrics{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:9px;
  margin-top:40px;
}

.metric{
  min-height:105px;
  padding:15px;
  border:1px solid rgba(189,223,244,.16);
  border-radius:14px;
  background:rgba(5,11,18,.74);
  backdrop-filter:blur(16px);
}

.metric-value{
  display:block;
  margin-top:18px;
  font:
    760 17px
    ui-monospace,
    monospace;
}

.console-card{
  margin-top:18px;
  padding:28px;
  border:1px solid var(--line);
  border-radius:22px;
  background:
    linear-gradient(
      180deg,
      rgba(13,23,35,.86),
      rgba(7,12,19,.92)
    );
  backdrop-filter:blur(18px);
}

.console-card[data-scene]{
  position:relative;
  overflow:hidden;
}

.console-heading{
  display:grid;
  grid-template-columns:60px 1fr auto;
  gap:15px;
  align-items:center;
  margin-bottom:25px;
}

.console-number{
  width:42px;
  height:42px;
  display:grid;
  place-items:center;
  border:1px solid rgba(67,215,255,.20);
  border-radius:12px;
  color:var(--cyan);
  background:rgba(67,215,255,.05);
  font:
    800 10px
    ui-monospace,
    monospace;
}

.console-heading h2{
  margin:0;
  font-size:25px;
  letter-spacing:-.04em;
}

.console-heading p{
  margin:4px 0 0;
  color:#8295a3;
  font-size:11px;
}

.state-pill{
  padding:6px 9px;
  border:1px solid rgba(57,240,160,.20);
  border-radius:999px;
  color:var(--green);
  background:rgba(57,240,160,.04);
  font:
    750 8px
    ui-monospace,
    monospace;
  letter-spacing:.10em;
}

.activation-layout{
  display:grid;
  grid-template-columns:1.1fr .9fr;
  gap:12px;
}

.action-panel{
  padding:20px;
  border:1px solid var(--line);
  border-radius:16px;
  background:#080d14;
}

.action-panel p{
  color:#8598a7;
  font-size:12px;
  line-height:1.6;
}

.key,
.key-box{
  margin-top:14px;
  padding:15px;
  border:1px solid rgba(57,240,160,.18);
  border-radius:13px;
  background:rgba(57,240,160,.03);
}

.key-value{
  display:block;
  overflow-wrap:anywhere;
  color:var(--green);
  font:
    680 11px
    ui-monospace,
    monospace;
}

.key-value:empty::before{
  content:"KEY WILL APPEAR HERE ONCE";
  color:#5f7381;
}

.warning{
  color:var(--amber)!important;
}

.demo-steps{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:9px;
  margin:20px 0;
}

.step{
  min-height:125px;
  padding:15px;
  border:1px solid var(--line);
  border-radius:14px;
  background:#080d14;
}

.step > span:first-child{
  display:block;
  margin-bottom:28px;
  color:var(--cyan);
  font:
    750 9px
    ui-monospace,
    monospace;
}

.result,
.big-result{
  margin-top:15px;
  padding:18px;
  overflow-x:auto;
  border:1px solid var(--line);
  border-radius:15px;
  background:#050a10;
  color:#a7bbc8;
  font:
    650 11px/1.65
    ui-monospace,
    monospace;
}

.result:empty::before,
.big-result:empty::before{
  content:"AWAITING EXECUTION";
  color:#536774;
}

.result-fail{
  color:var(--red);
}

.integration-grid{
  display:grid;
  gap:12px;
}

.command{
  position:relative;
}

.command-label{
  display:block;
  margin-bottom:7px;
  color:#758998;
  font:
    720 8px
    ui-monospace,
    monospace;
  letter-spacing:.13em;
}

.code-block{
  position:relative;
  min-height:54px;
  padding:17px 86px 17px 17px;
  overflow-x:auto;
  border:1px solid var(--line);
  border-radius:13px;
  background:#050a10;
}

.code-block code{
  color:#d7e5eb;
  font:
    650 11px
    ui-monospace,
    monospace;
}

.copy-small{
  position:absolute;
  right:8px;
  top:8px;
  padding:8px 10px;
  font-size:8px;
}

footer{
  width:min(1320px,calc(100% - 40px));
  margin:35px auto 0;
  padding:28px 0 45px;
  border-top:1px solid var(--line);
  display:flex;
  justify-content:space-between;
  color:#657988;
  font-size:9px;
}

@media(max-width:980px){
  .hero{
    grid-template-columns:1fr;
  }

  .visual{
    min-height:500px;
  }

  .section-head{
    grid-template-columns:1fr;
  }

  .plans,
  .metrics,
  .flow,
  .demo-steps{
    grid-template-columns:repeat(2,1fr);
  }

  .activation-layout{
    grid-template-columns:1fr;
  }
}

@media(max-width:620px){
  .topbar-inner,
  .hero,
  .section,
  .dashboard,
  footer{
    width:calc(100% - 24px);
  }

  .topbar{
    height:64px;
  }

  .hero{
    padding-top:100px;
  }

  .hero h1,
  .dashboard-hero h1{
    font-size:46px;
  }

  .visual{
    min-height:440px;
  }

  .section{
    padding:48px 18px;
    border-radius:23px;
  }

  .plans,
  .metrics,
  .flow,
  .demo-steps{
    grid-template-columns:1fr;
  }

  .dashboard{
    padding-top:95px;
  }

  .dashboard-hero{
    padding:35px 20px;
  }

  .console-card{
    padding:18px;
  }

  .console-heading{
    grid-template-columns:48px 1fr;
  }

  .state-pill{
    grid-column:2;
    justify-self:start;
  }

  footer{
    flex-direction:column;
    gap:8px;
  }
}
</style>
</head>

<body>

<div class="shell">

<header class="topbar">
  <div class="topbar-inner">

    <a class="brand" href="/">
      <span class="brand-mark">1\xD7</span>
      <span>Once</span>
    </a>

    <div class="top-status">
      <i></i>
      PLAYGROUND / STRIPE TEST
    </div>

  </div>
</header>


<main>

<section class="hero">

  <div class="hero-copy">

    <div class="eyebrow">
      <i></i>
      ONCE PLAYGROUND / 001
    </div>

    <h1>
      BREAK THE NETWORK.
      <br>
      NOT THE
      <em>TRANSACTION.</em>
    </h1>

    <p>
      Run the failure mode that makes consequential AI-agent actions
      dangerous. Let the provider execute, lose the response, retry the
      same operation \u2014 then inspect what actually happened.
    </p>

  </div>


  <div class="visual">

    <div class="visual-top">
      <span>EXECUTION SAFETY / LIVE MODEL</span>
      <span class="live">READY</span>
    </div>

    <div class="scan"></div>

    <div class="hud">

      <div class="hud-item">
        <small>ATTEMPT 01</small>
        <strong>EXECUTE</strong>
      </div>

      <div class="hud-item">
        <small>NETWORK</small>
        <strong class="red">AMBIGUOUS</strong>
      </div>

      <div class="hud-item">
        <small>ATTEMPT 02</small>
        <strong>RETRY</strong>
      </div>

      <div class="hud-item">
        <small>EXPECTED EFFECTS</small>
        <strong class="green">01</strong>
      </div>

    </div>

  </div>

</section>


<section
  class="section scene"
  style='--scene:url("https://images.pexels.com/photos/12266914/pexels-photo-12266914.jpeg?auto=compress&cs=tinysrgb&w=2200")'
>

  <div class="section-head">

    <span class="chapter">
      01 \xB7 FAILURE MODEL
    </span>

    <div>
      <h2>
        The provider succeeds.
        <br>
        The response disappears.
      </h2>

      <p>
        A timeout cannot prove that the external action failed.
        Retrying blindly can perform the same irreversible operation twice.
      </p>
    </div>

  </div>


  <div class="flow">

    <div class="flow-step">
      <span>01</span>
      <strong>AGENT</strong>
      <small>Send consequential action</small>
    </div>

    <div class="flow-step">
      <span>02</span>
      <strong>PROVIDER</strong>
      <small class="green">Side effect committed</small>
    </div>

    <div class="flow-step">
      <span>03</span>
      <strong>NETWORK</strong>
      <small class="red">Response lost</small>
    </div>

    <div class="flow-step">
      <span>04</span>
      <strong>RETRY</strong>
      <small>Duplicate exposure</small>
    </div>

  </div>

</section>


<section class="section">

  <div class="section-head">

    <span class="chapter">
      02 \xB7 START SANDBOX
    </span>

    <div>
      <h2>
        Choose the environment.
        <br>
        Then prove it.
      </h2>

      <p>
        Stripe is running in test mode. These plans exercise the real
        activation path without charging real money.
      </p>
    </div>

  </div>


  <div class="plans">

    <article class="plan">

      <span class="plan-tag">
        SANDBOX / PRO
      </span>

      <h3>Pro</h3>

      <div class="price">
        \xA329
      </div>

      <small>
        Test subscription. No real charge is made.
      </small>

      <button
        type="button"
        data-plan="pro"
        class="primary"
      >
        Start Pro Sandbox
      </button>

    </article>


    <article class="plan plan-featured">

      <span class="plan-tag">
        SANDBOX / STARTUP
      </span>

      <h3>Startup</h3>

      <div class="price">
        \xA379
      </div>

      <small>
        Test subscription. No real charge is made.
      </small>

      <button
        type="button"
        data-plan="startup"
        class="primary"
      >
        Start Startup Sandbox
      </button>

    </article>


    <article class="plan">

      <span class="plan-tag">
        SANDBOX / SCALE
      </span>

      <h3>Scale</h3>

      <div class="price">
        \xA3199
      </div>

      <small>
        Test subscription. No real charge is made.
      </small>

      <button
        type="button"
        data-plan="scale"
        class="primary"
      >
        Start Scale Sandbox
      </button>

    </article>

  </div>


  <div
    id="status"
    class="status"
    aria-live="polite"
  ></div>

</section>


<section
  class="section scene"
  style='--scene:url("https://images.pexels.com/photos/1624895/pexels-photo-1624895.jpeg?auto=compress&cs=tinysrgb&w=2200")'
>

  <div class="section-head">

    <span class="chapter">
      03 \xB7 EXPECTED PROOF
    </span>

    <div>
      <h2>
        Two attempts.
        <br>
        One external effect.
      </h2>

      <p>
        After activation, the live demo deliberately creates the ambiguous
        retry path and checks provider truth afterwards.
      </p>
    </div>

  </div>


  <div class="flow">

    <div class="flow-step">
      <span>ATTEMPTS</span>
      <strong>02</strong>
      <small>Same operation identity</small>
    </div>

    <div class="flow-step">
      <span>LEDGER</span>
      <strong class="green">CONFIRMED</strong>
      <small>Durable state resolved</small>
    </div>

    <div class="flow-step">
      <span>SIDE EFFECTS</span>
      <strong class="green">01</strong>
      <small>Provider truth</small>
    </div>

    <div class="flow-step">
      <span>DECISION</span>
      <strong class="green">SAFE</strong>
      <small>Duplicate suppressed</small>
    </div>

  </div>

</section>

</main>


<footer>
  <span>1\xD7 ONCE</span>
  <span>Execution safety for consequential AI-agent operations.</span>
  <span>PLAYGROUND</span>
</footer>

</div>

<script>
    const status =
      document.getElementById(
        "status"
      );

    const buttons =
      Array.from(
        document.querySelectorAll(
          "[data-plan]"
        )
      );

    async function startCheckout(
      button
    ) {
      const plan =
        button.dataset.plan;

      status.classList.remove(
        "error"
      );

      status.textContent =
        "Creating Stripe test checkout\u2026";

      for (const item of buttons) {
        item.disabled = true;
      }

      try {
        const response =
          await fetch(
            "/api/checkout",
            {
              method: "POST",

              headers: {
                "content-type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  plan
                })
            }
          );

        const body =
          await response.json();

        if (
          !response.ok ||
          !body.url
        ) {
          throw new Error(
            body.error ||
            "checkout_failed"
          );
        }

        status.textContent =
          "Redirecting to Stripe test checkout\u2026";

        window.location.assign(
          body.url
        );
      }
      catch (error) {
        status.classList.add(
          "error"
        );

        status.textContent =
          "Could not start sandbox checkout: " +
          error.message;

        for (const item of buttons) {
          item.disabled = false;
        }
      }
    }

    for (const button of buttons) {
      button.addEventListener(
        "click",
        () => startCheckout(button)
      );
    }

    const params =
      new URLSearchParams(
        window.location.search
      );

    if (
      params.get("checkout") ===
      "cancelled"
    ) {
      status.textContent =
        "Stripe test checkout cancelled.";
    }
  <\/script>

</body>
</html>`;
var SUCCESS_PAGE = `<!doctype html>
<html lang="en">

<head>
<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<meta
  name="description"
  content="Once activation and live retry proof."
>

<title>Once \u2014 Activation</title>

<style>
:root{
  --bg:#05070b;
  --bg2:#081019;
  --panel:rgba(10,17,26,.82);
  --panel2:rgba(13,23,35,.86);
  --line:rgba(157,189,218,.14);
  --line2:rgba(157,189,218,.25);
  --text:#f5f8fb;
  --muted:#8ea0b0;
  --green:#39f0a0;
  --cyan:#43d7ff;
  --red:#ff6878;
  --amber:#ffba62;
  --shadow:0 30px 100px rgba(0,0,0,.46);
  color-scheme:dark;
}

*{
  box-sizing:border-box;
}

html{
  scroll-behavior:smooth;
}

body{
  margin:0;
  min-height:100vh;
  color:var(--text);
  background:#05070b;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  overflow-x:hidden;
}

body::before{
  content:"";
  position:fixed;
  inset:0;
  pointer-events:none;
  z-index:-1;
  opacity:.15;
  background-image:
    linear-gradient(
      rgba(255,255,255,.025) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      rgba(255,255,255,.02) 1px,
      transparent 1px
    );
  background-size:44px 44px;
}

a{
  color:inherit;
  text-decoration:none;
}

button{
  font:inherit;
}

.shell{
  position:relative;
  z-index:1;
}

.topbar{
  position:fixed;
  z-index:100;
  top:0;
  left:0;
  right:0;
  height:72px;
  border-bottom:1px solid rgba(255,255,255,.055);
  background:rgba(5,7,11,.78);
  backdrop-filter:blur(18px);
}

.topbar-inner{
  width:min(1320px,calc(100% - 40px));
  height:100%;
  margin:auto;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:20px;
}

.brand{
  display:flex;
  align-items:center;
  gap:11px;
  font-size:19px;
  font-weight:780;
  letter-spacing:-.035em;
}

.brand-mark{
  width:38px;
  height:38px;
  display:grid;
  place-items:center;
  border:1px solid rgba(99,229,255,.28);
  border-radius:12px;
  background:
    linear-gradient(
      145deg,
      rgba(67,215,255,.18),
      rgba(57,240,160,.12)
    );
  color:var(--green);
  font:
    800 12px
    ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}

.top-status{
  display:flex;
  align-items:center;
  gap:8px;
  padding:7px 11px;
  border:1px solid var(--line);
  border-radius:999px;
  color:#8ea1b0;
  font-size:9px;
  letter-spacing:.10em;
}

.top-status i{
  width:7px;
  height:7px;
  border-radius:50%;
  background:var(--green);
  box-shadow:0 0 14px var(--green);
}

.hero{
  width:min(1320px,calc(100% - 40px));
  min-height:760px;
  margin:auto;
  padding:128px 0 40px;
  display:grid;
  grid-template-columns:1fr .94fr;
  gap:38px;
  align-items:center;
}

.eyebrow{
  display:flex;
  align-items:center;
  gap:10px;
  color:#97aab7;
  font:
    750 9px
    ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  letter-spacing:.15em;
}

.eyebrow i{
  width:7px;
  height:7px;
  border-radius:50%;
  background:var(--green);
  box-shadow:0 0 15px var(--green);
}

.hero h1{
  margin:23px 0 24px;
  font-size:clamp(52px,6vw,88px);
  line-height:.91;
  letter-spacing:-.065em;
}

.hero h1 em{
  color:var(--green);
  font-style:normal;
}

.hero-copy{
  max-width:720px;
}

.hero-copy > p{
  max-width:680px;
  color:#98a9b6;
  font-size:16px;
  line-height:1.7;
}

.visual{
  position:relative;
  min-height:590px;
  overflow:hidden;
  border:1px solid var(--line2);
  border-radius:30px;
  box-shadow:var(--shadow);
  background:
    linear-gradient(
      180deg,
      rgba(4,8,13,.05),
      rgba(4,8,13,.28) 40%,
      rgba(4,8,13,.93)
    ),
    url("https://images.pexels.com/photos/17323801/pexels-photo-17323801/free-photo-of-network-rack.jpeg?auto=compress&cs=tinysrgb&w=2200")
    center/cover no-repeat;
}

.visual::after{
  content:"";
  position:absolute;
  inset:0;
  background:
    radial-gradient(
      circle at 70% 22%,
      rgba(67,215,255,.14),
      transparent 34%
    );
}

.visual-top{
  position:absolute;
  z-index:3;
  top:19px;
  left:19px;
  right:19px;
  display:flex;
  justify-content:space-between;
  color:#a0b4c0;
  font:
    700 8px
    ui-monospace,
    monospace;
  letter-spacing:.15em;
}

.live{
  color:var(--green);
}

.scan{
  position:absolute;
  z-index:3;
  left:0;
  right:0;
  top:22%;
  height:1px;
  background:
    linear-gradient(
      90deg,
      transparent,
      var(--cyan),
      transparent
    );
  box-shadow:0 0 14px rgba(67,215,255,.6);
  animation:scan 7s ease-in-out infinite;
}

@keyframes scan{
  0%,100%{top:18%;opacity:.25}
  50%{top:72%;opacity:.85}
}

.hud{
  position:absolute;
  z-index:4;
  left:20px;
  right:20px;
  bottom:20px;
  display:grid;
  grid-template-columns:repeat(2,1fr);
  gap:9px;
}

.hud-item{
  padding:15px;
  border:1px solid rgba(189,223,244,.17);
  border-radius:15px;
  background:rgba(5,11,18,.72);
  backdrop-filter:blur(18px);
}

.hud-item small,
.metric small,
.telemetry-label{
  display:block;
  color:#718695;
  font:
    720 8px
    ui-monospace,
    monospace;
  letter-spacing:.14em;
}

.hud-item strong{
  display:block;
  margin-top:8px;
  font:
    760 19px
    ui-monospace,
    monospace;
}

.green{
  color:var(--green)!important;
}

.cyan{
  color:var(--cyan)!important;
}

.red{
  color:var(--red)!important;
}

.section{
  position:relative;
  width:min(1320px,calc(100% - 40px));
  margin:28px auto;
  padding:64px 42px;
  overflow:hidden;
  border:1px solid var(--line);
  border-radius:30px;
  background:
    linear-gradient(
      90deg,
      rgba(5,9,14,.96),
      rgba(5,9,14,.88)
    );
  box-shadow:0 30px 90px rgba(0,0,0,.20);
}

.scene{
  isolation:isolate;
}

.scene::before{
  content:"";
  position:absolute;
  z-index:-2;
  inset:0;
  background-image:var(--scene);
  background-size:cover;
  background-position:center;
  filter:saturate(.65) contrast(1.08);
  opacity:.34;
}

.scene::after{
  content:"";
  position:absolute;
  z-index:-1;
  inset:0;
  background:
    radial-gradient(
      700px 430px at 80% 15%,
      rgba(67,215,255,.07),
      transparent 60%
    ),
    linear-gradient(
      90deg,
      rgba(5,9,14,.98),
      rgba(5,9,14,.86) 55%,
      rgba(5,9,14,.72)
    );
}

.section-head{
  display:grid;
  grid-template-columns:170px 1fr;
  gap:28px;
  margin-bottom:42px;
}

.chapter{
  color:var(--cyan);
  font:
    750 10px
    ui-monospace,
    monospace;
  letter-spacing:.14em;
}

.section h2{
  max-width:900px;
  margin:0 0 13px;
  font-size:clamp(37px,4.7vw,64px);
  line-height:.98;
  letter-spacing:-.052em;
}

.section-head p{
  max-width:760px;
  color:#8ea0ae;
  line-height:1.65;
  font-size:13px;
}

.plans{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:11px;
}

.plan{
  position:relative;
  min-height:300px;
  padding:22px;
  border:1px solid var(--line);
  border-radius:19px;
  background:
    linear-gradient(
      180deg,
      rgba(14,24,37,.86),
      rgba(7,12,19,.89)
    );
  backdrop-filter:blur(16px);
}

.plan-featured{
  border-color:rgba(57,240,160,.27);
  box-shadow:inset 0 0 40px rgba(57,240,160,.025);
}

.plan-tag{
  color:var(--cyan);
  font:
    700 8px
    ui-monospace,
    monospace;
  letter-spacing:.13em;
}

.plan h3{
  margin:36px 0 5px;
  font-size:23px;
}

.price{
  margin:12px 0 4px;
  color:#f5f8fb;
  font:
    760 37px
    ui-monospace,
    monospace;
  letter-spacing:-.05em;
}

.plan small{
  display:block;
  min-height:48px;
  color:#748896;
  line-height:1.5;
}

button{
  appearance:none;
  cursor:pointer;
  border:1px solid var(--line2);
  border-radius:11px;
  padding:11px 15px;
  background:rgba(255,255,255,.025);
  color:#dce8ef;
  font-size:10px;
  font-weight:800;
  transition:.18s;
}

button:hover:not(:disabled){
  transform:translateY(-1px);
  border-color:rgba(57,240,160,.42);
}

button:disabled{
  cursor:not-allowed;
  opacity:.45;
}

.primary{
  background:var(--green);
  border-color:transparent;
  color:#04120b;
  box-shadow:0 0 28px rgba(57,240,160,.12);
}

.plan button{
  width:100%;
  margin-top:20px;
}

.status{
  margin-top:18px;
  min-height:20px;
  color:#8fa2b1;
  font:
    650 10px
    ui-monospace,
    monospace;
}

.status.error{
  color:var(--red);
}

.flow{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:10px;
}

.flow-step{
  min-height:150px;
  padding:17px;
  border:1px solid var(--line);
  border-radius:15px;
  background:rgba(8,14,22,.78);
}

.flow-step span{
  display:block;
  color:var(--cyan);
  font:
    700 9px
    ui-monospace,
    monospace;
}

.flow-step strong{
  display:block;
  margin:44px 0 6px;
  font-size:13px;
}

.flow-step small{
  color:#758897;
}

.dashboard{
  width:min(1320px,calc(100% - 40px));
  margin:0 auto;
  padding:122px 0 80px;
}

.dashboard-hero{
  position:relative;
  min-height:460px;
  overflow:hidden;
  padding:55px;
  border:1px solid var(--line2);
  border-radius:30px;
  background:
    linear-gradient(
      90deg,
      rgba(5,9,14,.98),
      rgba(5,9,14,.74)
    ),
    url("https://images.pexels.com/photos/5480781/pexels-photo-5480781.jpeg?auto=compress&cs=tinysrgb&w=2200")
    center/cover no-repeat;
  box-shadow:var(--shadow);
}

.dashboard-hero h1{
  max-width:820px;
  margin:24px 0 18px;
  font-size:clamp(48px,6vw,82px);
  line-height:.92;
  letter-spacing:-.06em;
}

.dashboard-hero p{
  max-width:660px;
  color:#97a8b5;
  line-height:1.65;
}

.metrics{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:9px;
  margin-top:40px;
}

.metric{
  min-height:105px;
  padding:15px;
  border:1px solid rgba(189,223,244,.16);
  border-radius:14px;
  background:rgba(5,11,18,.74);
  backdrop-filter:blur(16px);
}

.metric-value{
  display:block;
  margin-top:18px;
  font:
    760 17px
    ui-monospace,
    monospace;
}

.console-card{
  margin-top:18px;
  padding:28px;
  border:1px solid var(--line);
  border-radius:22px;
  background:
    linear-gradient(
      180deg,
      rgba(13,23,35,.86),
      rgba(7,12,19,.92)
    );
  backdrop-filter:blur(18px);
}

.console-card[data-scene]{
  position:relative;
  overflow:hidden;
}

.console-heading{
  display:grid;
  grid-template-columns:60px 1fr auto;
  gap:15px;
  align-items:center;
  margin-bottom:25px;
}

.console-number{
  width:42px;
  height:42px;
  display:grid;
  place-items:center;
  border:1px solid rgba(67,215,255,.20);
  border-radius:12px;
  color:var(--cyan);
  background:rgba(67,215,255,.05);
  font:
    800 10px
    ui-monospace,
    monospace;
}

.console-heading h2{
  margin:0;
  font-size:25px;
  letter-spacing:-.04em;
}

.console-heading p{
  margin:4px 0 0;
  color:#8295a3;
  font-size:11px;
}

.state-pill{
  padding:6px 9px;
  border:1px solid rgba(57,240,160,.20);
  border-radius:999px;
  color:var(--green);
  background:rgba(57,240,160,.04);
  font:
    750 8px
    ui-monospace,
    monospace;
  letter-spacing:.10em;
}

.activation-layout{
  display:grid;
  grid-template-columns:1.1fr .9fr;
  gap:12px;
}

.action-panel{
  padding:20px;
  border:1px solid var(--line);
  border-radius:16px;
  background:#080d14;
}

.action-panel p{
  color:#8598a7;
  font-size:12px;
  line-height:1.6;
}

.key,
.key-box{
  margin-top:14px;
  padding:15px;
  border:1px solid rgba(57,240,160,.18);
  border-radius:13px;
  background:rgba(57,240,160,.03);
}

.key-value{
  display:block;
  overflow-wrap:anywhere;
  color:var(--green);
  font:
    680 11px
    ui-monospace,
    monospace;
}

.key-value:empty::before{
  content:"KEY WILL APPEAR HERE ONCE";
  color:#5f7381;
}

.warning{
  color:var(--amber)!important;
}

.demo-steps{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:9px;
  margin:20px 0;
}

.step{
  min-height:125px;
  padding:15px;
  border:1px solid var(--line);
  border-radius:14px;
  background:#080d14;
}

.step > span:first-child{
  display:block;
  margin-bottom:28px;
  color:var(--cyan);
  font:
    750 9px
    ui-monospace,
    monospace;
}

.result,
.big-result{
  margin-top:15px;
  padding:18px;
  overflow-x:auto;
  border:1px solid var(--line);
  border-radius:15px;
  background:#050a10;
  color:#a7bbc8;
  font:
    650 11px/1.65
    ui-monospace,
    monospace;
}

.result:empty::before,
.big-result:empty::before{
  content:"AWAITING EXECUTION";
  color:#536774;
}

.result-fail{
  color:var(--red);
}

.integration-grid{
  display:grid;
  gap:12px;
}

.command{
  position:relative;
}

.command-label{
  display:block;
  margin-bottom:7px;
  color:#758998;
  font:
    720 8px
    ui-monospace,
    monospace;
  letter-spacing:.13em;
}

.code-block{
  position:relative;
  min-height:54px;
  padding:17px 86px 17px 17px;
  overflow-x:auto;
  border:1px solid var(--line);
  border-radius:13px;
  background:#050a10;
}

.code-block code{
  color:#d7e5eb;
  font:
    650 11px
    ui-monospace,
    monospace;
}

.copy-small{
  position:absolute;
  right:8px;
  top:8px;
  padding:8px 10px;
  font-size:8px;
}

footer{
  width:min(1320px,calc(100% - 40px));
  margin:35px auto 0;
  padding:28px 0 45px;
  border-top:1px solid var(--line);
  display:flex;
  justify-content:space-between;
  color:#657988;
  font-size:9px;
}

@media(max-width:980px){
  .hero{
    grid-template-columns:1fr;
  }

  .visual{
    min-height:500px;
  }

  .section-head{
    grid-template-columns:1fr;
  }

  .plans,
  .metrics,
  .flow,
  .demo-steps{
    grid-template-columns:repeat(2,1fr);
  }

  .activation-layout{
    grid-template-columns:1fr;
  }
}

@media(max-width:620px){
  .topbar-inner,
  .hero,
  .section,
  .dashboard,
  footer{
    width:calc(100% - 24px);
  }

  .topbar{
    height:64px;
  }

  .hero{
    padding-top:100px;
  }

  .hero h1,
  .dashboard-hero h1{
    font-size:46px;
  }

  .visual{
    min-height:440px;
  }

  .section{
    padding:48px 18px;
    border-radius:23px;
  }

  .plans,
  .metrics,
  .flow,
  .demo-steps{
    grid-template-columns:1fr;
  }

  .dashboard{
    padding-top:95px;
  }

  .dashboard-hero{
    padding:35px 20px;
  }

  .console-card{
    padding:18px;
  }

  .console-heading{
    grid-template-columns:48px 1fr;
  }

  .state-pill{
    grid-column:2;
    justify-self:start;
  }

  footer{
    flex-direction:column;
    gap:8px;
  }
}
</style>
</head>

<body>

<div class="shell">

<header class="topbar">
  <div class="topbar-inner">

    <a class="brand" href="/">
      <span class="brand-mark">1\xD7</span>
      <span>Once</span>
    </a>

    <div class="top-status">
      <i></i>
      ACTIVATION / SANDBOX
    </div>

  </div>
</header>


<main class="dashboard">


<section class="dashboard-hero">

  <div class="eyebrow">
    <i></i>
    ONCE ACTIVATION / 001
  </div>

  <h1>
    YOUR AGENT
    <br>
    IS ALMOST
    <span class="green">PROTECTED.</span>
  </h1>

  <p>
    Activate your sandbox key, run the ambiguous retry test, then
    integrate the SDK into your project.
  </p>


  <div class="metrics">

    <div class="metric">
      <small>PLAN</small>
      <span
        id="plan"
        class="metric-value"
      >
        Activating\u2026
      </span>
    </div>

    <div class="metric">
      <small>CHECKOUT</small>
      <span class="metric-value green">
        CONFIRMED
      </span>
    </div>

    <div class="metric">
      <small>ENVIRONMENT</small>
      <span class="metric-value">
        STRIPE TEST
      </span>
    </div>

    <div class="metric">
      <small>LIMIT</small>
      <span
        id="limit"
        class="metric-value"
      >
        \u2014
      </span>
    </div>

  </div>

</section>



<section
  id="keyCard"
  class="console-card"
>

  <div class="console-heading">

    <span class="console-number">
      01
    </span>

    <div>
      <h2>
        Activate Once
      </h2>

      <p>
        Create the sandbox API key that authenticates this application.
      </p>
    </div>

    <span class="state-pill">
      READY
    </span>

  </div>


  <div class="activation-layout">

    <div class="action-panel">

      <span class="telemetry-label">
        ACTIVATION
      </span>

      <h3>
        Issue sandbox key
      </h3>

      <p>
        The raw key is returned once. Once does not retain it in
        recoverable form.
      </p>

      <button
        id="claim"
        type="button"
        class="primary"
      >
        Activate Once
      </button>

      <div
        id="claimStatus"
        class="status"
        aria-live="polite"
      ></div>

    </div>


    <div
      id="keyBox"
      class="action-panel key-box"
    >

      <span class="telemetry-label">
        API KEY / ONE-TIME DISPLAY
      </span>

      <div class="key">

        <code
          id="apiKey"
          class="key-value"
        ></code>

      </div>

      <button
        id="copyKey"
        type="button"
        class="copy-small"
      >
        Copy key
      </button>

      <p class="warning">
        Store this key securely. It cannot be recovered later.
      </p>

    </div>

  </div>

</section>



<section
  id="demoCard"
  class="console-card"
>

  <div class="console-heading">

    <span class="console-number">
      02
    </span>

    <div>
      <h2>
        Prove the retry
      </h2>

      <p>
        Deliberately create the failure mode Once is designed to resolve.
      </p>
    </div>

    <span class="state-pill">
      LIVE TEST
    </span>

  </div>


  <div class="demo-steps">

    <div class="step">
      <span>01</span>
      <strong>ATTEMPT 01</strong>
      <small>Provider performs the side effect</small>
    </div>

    <div class="step">
      <span>02</span>
      <strong>NETWORK</strong>
      <small class="red">Response becomes ambiguous</small>
    </div>

    <div class="step">
      <span>03</span>
      <strong>ATTEMPT 02</strong>
      <small>Same stable operation retries</small>
    </div>

    <div class="step">
      <span>04</span>
      <strong>PROVIDER TRUTH</strong>
      <small class="green">External effect remains one</small>
    </div>

  </div>


  <button
    id="runDemo"
    type="button"
    class="primary"
    disabled
  >
    Run live retry test
  </button>

  <div
    id="demoStatus"
    class="status"
    aria-live="polite"
  ></div>

  <div
    id="demoResult"
    class="big-result"
  ></div>

</section>



<section
  id="integrateCard"
  class="console-card"
>

  <div class="console-heading">

    <span class="console-number">
      03
    </span>

    <div>
      <h2>
        Integrate
      </h2>

      <p>
        Install the SDK, add the key, then run the setup and safety probe.
      </p>
    </div>

    <span class="state-pill">
      SDK 0.1.4
    </span>

  </div>


  <div class="integration-grid">


    <div class="command">

      <span class="command-label">
        INSTALL
      </span>

      <div class="code-block">

        <code>
          npm install @once-agent/sdk
        </code>

        <button
          type="button"
          class="copy-small"
          data-copy="npm install @once-agent/sdk"
        >
          Copy
        </button>

      </div>

    </div>


    <div class="command">

      <span class="command-label">
        ENVIRONMENT
      </span>

      <div class="code-block">

        <code id="envCommand">
          ONCE_API_KEY=&lt;your-key&gt;
        </code>

        <button
          id="copyEnv"
          type="button"
          class="copy-small"
          disabled
        >
          Copy
        </button>

      </div>

    </div>


    <div class="command">

      <span class="command-label">
        SETUP
      </span>

      <div class="code-block">

        <code>
          npx once setup .
        </code>

        <button
          type="button"
          class="copy-small"
          data-copy="npx once setup ."
        >
          Copy
        </button>

      </div>

    </div>


    <div class="command">

      <span class="command-label">
        SAFETY PROBE
      </span>

      <div class="code-block">

        <code>
          npx once doctor
        </code>

        <button
          type="button"
          class="copy-small"
          data-copy="npx once doctor"
        >
          Copy
        </button>

      </div>

    </div>


  </div>

</section>


</main>


<footer>
  <span>1\xD7 ONCE</span>
  <span>Agent execution safety.</span>
  <span>ACTIVATION / SANDBOX</span>
</footer>

</div>

<script>
    const claimButton =
      document.getElementById(
        "claim"
      );

    const copyKeyButton =
      document.getElementById(
        "copyKey"
      );

    const runDemoButton =
      document.getElementById(
        "runDemo"
      );

    const copyEnvButton =
      document.getElementById(
        "copyEnv"
      );

    const claimStatus =
      document.getElementById(
        "claimStatus"
      );

    const demoStatus =
      document.getElementById(
        "demoStatus"
      );

    const keyBox =
      document.getElementById(
        "keyBox"
      );

    const apiKey =
      document.getElementById(
        "apiKey"
      );

    const plan =
      document.getElementById(
        "plan"
      );

    const limit =
      document.getElementById(
        "limit"
      );

    const envCommand =
      document.getElementById(
        "envCommand"
      );

    const demoResult =
      document.getElementById(
        "demoResult"
      );

    const params =
      new URLSearchParams(
        window.location.search
      );

    const checkoutSessionId =
      params.get(
        "session_id"
      );

    let activeKey =
      null;

    const sleep =
      milliseconds =>
        new Promise(
          resolve =>
            setTimeout(
              resolve,
              milliseconds
            )
        );

    function prettyPlan(
      value
    ) {
      const normalized =
        String(
          value || ""
        ).toLowerCase();

      if (
        normalized === "pro"
      ) {
        return "Pro";
      }

      if (
        normalized === "startup"
      ) {
        return "Startup";
      }

      if (
        normalized === "scale"
      ) {
        return "Scale";
      }

      return value || "Active";
    }

    function prettyNumber(
      value
    ) {
      const number =
        Number(value);

      if (
        !Number.isFinite(number)
      ) {
        return "?";
      }

      return number.toLocaleString();
    }

    async function claim(
      attempt
    ) {
      attempt =
        attempt || 0;

      if (!checkoutSessionId) {
        claimStatus.className =
          "error";

        claimStatus.textContent =
          "Missing Stripe Checkout Session ID.";

        return;
      }

      claimButton.disabled =
        true;

      claimStatus.className =
        "";

      claimStatus.textContent =
        attempt === 0
          ? "Verifying Stripe checkout and Once entitlement?"
          : "Waiting for the Once entitlement webhook?";

      let response;
      let body;

      try {
        response =
          await fetch(
            "/api/claim",
            {
              method:
                "POST",

              headers: {
                "content-type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  session_id:
                    checkoutSessionId
                })
            }
          );

        body =
          await response.json();
      }
      catch {
        claimStatus.className =
          "error";

        claimStatus.textContent =
          "Network error while activating the sandbox.";

        claimButton.disabled =
          false;

        return;
      }

      if (
        response.status === 409 &&
        body.error ===
          "entitlement_pending" &&
        attempt < 20
      ) {
        await sleep(1500);

        return claim(
          attempt + 1
        );
      }

      if (
        response.ok &&
        body.api_key
      ) {
        activeKey =
          body.api_key;

        claimStatus.className =
          "success";

        claimStatus.textContent =
          "Sandbox activated. Your API key is ready.";

        apiKey.textContent =
          body.api_key;

        keyBox.style.display =
          "block";

        claimButton.style.display =
          "none";

        plan.textContent =
          prettyPlan(
            body.plan
          );

        limit.textContent =
          prettyNumber(
            body.monthly_limit
          );

        runDemoButton.disabled =
          false;

        demoStatus.textContent =
          "Ready. No real-world action will be performed.";

        envCommand.textContent =
          "ONCE_API_KEY=" +
          body.api_key;

        copyEnvButton.disabled =
          false;

        return;
      }

      if (
        response.ok &&
        body.already_claimed
      ) {
        claimStatus.className =
          "warning";

        claimStatus.textContent =
          "This API key was already issued. " +
          "Use the key you saved previously.";

        claimButton.style.display =
          "none";

        plan.textContent =
          prettyPlan(
            body.plan
          );

        limit.textContent =
          prettyNumber(
            body.monthly_limit
          );

        return;
      }

      claimStatus.className =
        "error";

      claimStatus.textContent =
        body.message ||
        body.error ||
        "Sandbox activation failed.";

      claimButton.disabled =
        false;
    }
    // --------------------------------------------------------
    // PLAYGROUND FUNNEL ANALYTICS
    //
    // Aggregate events only.
    // No API key, operation ID, Stripe data, cookie,
    // session ID, or other user identifier is sent.
    // --------------------------------------------------------

    function sendPlaygroundAnalytics(
      eventName
    ) {

      fetch(
        "/analytics/event",
        {
          method:
            "POST",

          headers: {
            "content-type":
              "application/json"
          },

          body:
            JSON.stringify({
              event:
                eventName,

              source:
                "playground"
            }),

          keepalive:
            true
        }
      )
        .catch(
          () => {
            // Analytics must never affect the demo.
          }
        );
    }


    async function runDemo() {
      if (!activeKey) {
        demoStatus.className =
          "error";

        demoStatus.textContent =
          "Activate your API key first.";

        return;
      }

      sendPlaygroundAnalytics(
        "playground_run"
      );

      runDemoButton.disabled =
        true;

      demoResult.style.display =
        "none";

      demoStatus.className =
        "";

      demoStatus.textContent =
        "Attempt #1: provider is committing the side effect?";

      await sleep(600);

      let response;
      let body;

      try {
        response =
          await fetch(
            "/api/demo",
            {
              method:
                "POST",

              headers: {
                authorization:
                  "Bearer " +
                  activeKey,

                "content-type":
                  "application/json"
              },

              body:
                JSON.stringify({})
            }
          );

        demoStatus.textContent =
          "Response failed. Retrying the same operation?";

        await sleep(700);

        body =
          await response.json();
      }
      catch {
        demoStatus.className =
          "error";

        demoStatus.textContent =
          "Demo network request failed.";

        runDemoButton.disabled =
          false;

        return;
      }

      if (!response.ok) {
        demoStatus.className =
          "error";

        demoStatus.textContent =
          body.error ||
          "Demo failed.";

        demoResult.style.display =
          "block";

        demoResult.innerHTML =
          '<div class="result-fail">' +
          '<div class="big-result">Demo did not complete</div>' +
          '<p>' +
          String(
            body.error ||
            "Unknown error"
          ) +
          '</p>' +
          '</div>';

        runDemoButton.disabled =
          false;

        return;
      }

      const result =
        body.result || {};

      const passed =
        result.duplicate_prevented ===
        true;
      if (
        passed &&
        String(
          result.state || ""
        ).toUpperCase() ===
          "CONFIRMED" &&
        Number(
          result.side_effects
        ) === 1
      ) {

        sendPlaygroundAnalytics(
          "once_confirmed"
        );
      }


      demoStatus.className =
        passed
          ? "success"
          : "error";

      demoStatus.textContent =
        passed
          ? "Once reconciled the ambiguous execution."
          : "The demo did not meet the expected safety condition.";

      const className =
        passed
          ? "result-pass"
          : "result-fail";

      const heading =
        passed
          ? "? Duplicate side effect prevented"
          : "Safety condition not met";

      demoResult.innerHTML =
        '<div class="' +
        className +
        '">' +

        '<div class="big-result">' +
        heading +
        '</div>' +

        '<div class="demo-steps">' +

        '<div class="step">' +
        '<span>Once state</span>' +
        '<strong>' +
        String(
          result.state || "UNKNOWN"
        ) +
        '</strong>' +
        '</div>' +

        '<div class="step">' +
        '<span>Execution attempts</span>' +
        '<strong>' +
        String(
          result.attempts ?? "?"
        ) +
        '</strong>' +
        '</div>' +

        '<div class="step">' +
        '<span>Actual side effects</span>' +
        '<strong>' +
        String(
          result.side_effects ?? "?"
        ) +
        '</strong>' +
        '</div>' +

        '<div class="step">' +
        '<span>Operation</span>' +
        '<strong>' +
        String(
          body.operation_id || "?"
        ) +
        '</strong>' +
        '</div>' +

        '</div>' +

        (
          passed
            ? '<p>' +
              'The provider performed the action, its response became ambiguous, ' +
              'and the operation was retried. Once preserved one actual side effect.' +
              '</p>'
            : ''
        ) +

        '</div>';

      demoResult.style.display =
        "block";

      runDemoButton.textContent =
        "Run another demo";

      runDemoButton.disabled =
        false;
    }

    claimButton.addEventListener(
      "click",
      () => claim(0)
    );

    copyKeyButton.addEventListener(
      "click",
      async () => {
        try {
          await navigator.clipboard.writeText(
            apiKey.textContent
          );

          copyKeyButton.textContent =
            "Copied";
        }
        catch {
          copyKeyButton.textContent =
            "Copy manually";
        }
      }
    );

    runDemoButton.addEventListener(
      "click",
      runDemo
    );

    copyEnvButton.addEventListener(
      "click",
      async () => {
        if (!activeKey) {
          return;
        }

        try {
          await navigator.clipboard.writeText(
            "ONCE_API_KEY=" +
            activeKey
          );

          copyEnvButton.textContent =
            "Copied";
        }
        catch {
          copyEnvButton.textContent =
            "Copy manually";
        }
      }
    );

    for (
      const button of
        document.querySelectorAll(
          "[data-copy]"
        )
    ) {
      button.addEventListener(
        "click",
        async () => {
          try {
            await navigator.clipboard.writeText(
              button.dataset.copy
            );

            button.textContent =
              "Copied";
          }
          catch {
            button.textContent =
              "Copy manually";
          }
        }
      );
    }
  <\/script>

</body>
</html>`;
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/analytics/event") {
      const origin = request.headers.get("origin") || "";
      const allowedOrigins = /* @__PURE__ */ new Set([
        "https://stringsofthemind-oss.github.io",
        "https://onceexec.pages.dev",
        "https://onceexec.com",
        "https://once-sandbox-playground.pennywatch.workers.dev",
        "https://playground.onceexec.com",
      ]);
      if (!allowedOrigins.has(origin)) {
        return json3(
          {
            error: "analytics_origin_denied"
          },
          403
        );
      }
      const corsHeaders = {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "cache-control": "no-store",
        "vary": "Origin"
      };
      if (request.method === "OPTIONS") {
        return new Response(
          null,
          {
            status: 204,
            headers: corsHeaders
          }
        );
      }
      if (request.method !== "POST") {
        return json3(
          {
            error: "method_not_allowed"
          },
          405,
          corsHeaders
        );
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json3(
          {
            error: "invalid_json"
          },
          400,
          corsHeaders
        );
      }
      const event = String(
        body?.event || ""
      ).trim();
      const source = String(
        body?.source || ""
      ).trim();
      const allowedEvents = /* @__PURE__ */ new Set([
        "page_view",
        "tester_used",
        "tester_run",
        "tester_cta_clicked",
        "playground_clicked",
        "playground_run",
        "once_confirmed",
        "mcp_copy_clicked",
        "sdk_copy_clicked",
        "install_path_clicked",
        "npm_clicked",
        "mcp_npm_clicked",
        "github_clicked",
        "agent_guide_clicked"
      ]);
      const allowedSources = /* @__PURE__ */ new Set([
        "website",
        "playground"
      ]);
      if (!allowedEvents.has(event)) {
        return json3(
          {
            error: "invalid_analytics_event"
          },
          400,
          corsHeaders
        );
      }
      if (!allowedSources.has(source)) {
        return json3(
          {
            error: "invalid_analytics_source"
          },
          400,
          corsHeaders
        );
      }
      if (!env.ONCE_ANALYTICS || typeof env.ONCE_ANALYTICS.writeDataPoint !== "function") {
        return json3(
          {
            error: "analytics_unavailable"
          },
          503,
          corsHeaders
        );
      }
      env.ONCE_ANALYTICS.writeDataPoint({
        blobs: [
          event,
          source
        ],
        doubles: [
          1
        ],
        indexes: [
          "once-product"
        ]
      });
      return new Response(
        null,
        {
          status: 204,
          headers: corsHeaders
        }
      );
    }
    if (url.pathname === "/demo-provider/execute" || url.pathname.startsWith(
      "/demo-provider/truth/"
    )) {
      if (!env.SANDBOX_DEMO_PROVIDER_TOKEN) {
        return json3(
          {
            error: "sandbox_demo_provider_not_configured"
          },
          503
        );
      }
      const authorization = request.headers.get(
        "authorization"
      ) || "";
      if (!authorization.startsWith(
        "Bearer "
      )) {
        return json3(
          {
            error: "provider_token_required"
          },
          401
        );
      }
      const supplied = authorization.substring(
        "Bearer ".length
      ).trim();
      if (!timingSafeTextEqual(
        supplied,
        env.SANDBOX_DEMO_PROVIDER_TOKEN
      )) {
        return json3(
          {
            error: "provider_unauthorized"
          },
          403
        );
      }
      if (request.method === "POST" && url.pathname === "/demo-provider/execute") {
        let rawBody;
        let body;
        try {
          rawBody = await request.text();
          body = JSON.parse(
            rawBody
          );
        } catch {
          return json3(
            {
              error: "invalid_json"
            },
            400
          );
        }
        const operationId = String(
          body?.operation_id || ""
        ).trim();
        if (!operationId) {
          return json3(
            {
              error: "operation_id_required"
            },
            400
          );
        }
        const id = env.SANDBOX_DEMO.idFromName(
          operationId
        );
        const stub = env.SANDBOX_DEMO.get(
          id
        );
        return stub.fetch(
          new Request(
            "https://sandbox.internal/execute",
            {
              method: "POST",
              headers: {
                "content-type": "application/json"
              },
              body: rawBody
            }
          )
        );
      }
      if (request.method === "GET" && url.pathname.startsWith(
        "/demo-provider/truth/"
      )) {
        const operationId = decodeURIComponent(
          url.pathname.substring(
            "/demo-provider/truth/".length
          )
        );
        if (!operationId) {
          return json3(
            {
              error: "operation_id_required"
            },
            400
          );
        }
        const id = env.SANDBOX_DEMO.idFromName(
          operationId
        );
        const stub = env.SANDBOX_DEMO.get(
          id
        );
        return stub.fetch(
          new Request(
            "https://sandbox.internal/truth",
            {
              method: "GET"
            }
          )
        );
      }
      return json3(
        {
          error: "method_not_allowed"
        },
        405
      );
    }
    if (request.method === "POST" && url.pathname === "/api/demo") {
      if (!env.ONCE_CORE_URL || !env.SANDBOX_DEMO_PROVIDER_TOKEN) {
        return json3(
          {
            error: "sandbox_demo_not_configured"
          },
          503
        );
      }
      const authorization = request.headers.get(
        "authorization"
      ) || "";
      if (!authorization.startsWith(
        "Bearer once_test_"
      )) {
        return json3(
          {
            error: "once_api_key_required"
          },
          401
        );
      }
      const onceAuthorization = authorization;
      const core = String(
        env.ONCE_CORE_URL
      ).replace(
        /\/+$/,
        ""
      );
      const coreStub = q18TruthStub(
        env
      );
      async function coreFetch(target, init) {
        const targetUrl = new URL(
          target
        );
        return coreStub.fetch(
          new Request(
            "https://q18.internal" + targetUrl.pathname + targetUrl.search,
            init
          )
        );
      }
      __name(coreFetch, "coreFetch");
      const providerName = "sandbox-demo-v2";
      const configuredDemoProviderBaseUrl = String(
        env.SANDBOX_DEMO_PROVIDER_BASE_URL || ""
      ).trim().replace(/\/+$/, "");
      const providerBaseUrl = configuredDemoProviderBaseUrl || url.origin + "/demo-provider";
      const demoTargetUrl = providerBaseUrl + "/execute";
      async function responseJson(response) {
        try {
          return await response.json();
        } catch {
          return null;
        }
      }
      __name(responseJson, "responseJson");
      let providerRead;
      try {
        providerRead = await coreFetch(
          core + "/v1/providers/" + encodeURIComponent(
            providerName
          ),
          {
            method: "GET",
            headers: {
              authorization: onceAuthorization
            }
          }
        );
      } catch {
        return json3(
          {
            error: "once_provider_lookup_network_error"
          },
          502
        );
      }
      if (providerRead.status === 404) {
        let registerResponse;
        try {
          registerResponse = await coreFetch(
            core + "/v1/providers",
            {
              method: "POST",
              headers: {
                authorization: onceAuthorization,
                "content-type": "application/json"
              },
              body: JSON.stringify({
                name: providerName,
                type: "http_v1",
                base_url: providerBaseUrl,
                allowed_urls: [demoTargetUrl],
                token: env.SANDBOX_DEMO_PROVIDER_TOKEN
              })
            }
          );
        } catch {
          return json3(
            {
              error: "once_provider_registration_network_error"
            },
            502
          );
        }
        if (!registerResponse.ok) {
          const registerBody = await responseJson(
            registerResponse
          );
          return json3(
            {
              error: "once_provider_registration_failed",
              status: registerResponse.status,
              detail: registerBody?.error || null
            },
            502
          );
        }
      } else if (!providerRead.ok) {
        const providerBody = await responseJson(
          providerRead
        );
        return json3(
          {
            error: "once_provider_lookup_failed",
            status: providerRead.status,
            detail: providerBody?.error || null
          },
          502
        );
      }
      const operationId = "demo:" + crypto.randomUUID().replaceAll(
        "-",
        ""
      );
      const executeBody = {
        operation_id: operationId,
        provider: providerName,
        action: {
          type: "http_write_v1",
          method: "POST",
          url: demoTargetUrl,
          body_json: JSON.stringify({
            demo: true,
            description: "Demonstrate ambiguous execution safety"
          }),
          fault: "commit_then_503",
          description: "Demonstrate ambiguous execution safety"
        }
      };
      async function callExecute() {
        try {
          const response = await coreFetch(
            core + "/v1/execute",
            {
              method: "POST",
              headers: {
                authorization: onceAuthorization,
                "content-type": "application/json"
              },
              body: JSON.stringify(
                executeBody
              )
            }
          );
          return {
            http_status: response.status,
            body: await responseJson(
              response
            )
          };
        } catch {
          return {
            http_status: 0,
            body: {
              error: "network_error"
            }
          };
        }
      }
      __name(callExecute, "callExecute");
      const first = await callExecute();
      await new Promise(
        (resolve) => setTimeout(
          resolve,
          250
        )
      );
      const retry = await callExecute();
      let truth = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const response = await coreFetch(
            core + "/v1/truth/" + encodeURIComponent(
              operationId
            ),
            {
              method: "GET",
              headers: {
                authorization: onceAuthorization
              }
            }
          );
          if (response.ok) {
            truth = await responseJson(
              response
            );
            const state = String(
              truth?.ledger_state || truth?.state || ""
            ).toUpperCase();
            if (state === "CONFIRMED" || state === "FAILED" || state === "QUARANTINED") {
              break;
            }
          }
        } catch {
        }
        await new Promise(
          (resolve) => setTimeout(
            resolve,
            500
          )
        );
      }
      const finalState = String(
        truth?.ledger_state || truth?.state || ""
      ).toUpperCase();

      if (
        !truth ||
        (
          finalState !== "CONFIRMED" &&
          finalState !== "FAILED" &&
          finalState !== "QUARANTINED"
        )
      ) {
        return json3(
          {
            error: "truth_not_terminal",
            operation_id: operationId,
            state: finalState || null,
            provider_executed:
              truth?.provider_executed ?? null,
            side_effects:
              truth?.side_effects ?? null,
            first,
            retry
          },
          502
        );
      }
      const sideEffects = Number(
        truth?.side_effects
      );
      const attempts = Number(
        truth?.attempts
      );
      const protectedSuccessfully = finalState === "CONFIRMED" && sideEffects === 1;
      return json3({
        demo: true,
        operation_id: operationId,
        first_attempt: {
          http_status: first.http_status,
          state: first.body?.state || first.body?.ledger_state || null
        },
        retry_attempt: {
          http_status: retry.http_status,
          state: retry.body?.state || retry.body?.ledger_state || null
        },
        result: {
          state: finalState,
          attempts: Number.isFinite(
            attempts
          ) ? attempts : null,
          side_effects: Number.isFinite(
            sideEffects
          ) ? sideEffects : null,
          duplicate_prevented: protectedSuccessfully
        },
        truth
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json3({
        service: "once-sandbox-playground",
        status: "online",
        mode: "sandbox",
        stripe: "test",
        stripe_secret_configured: Boolean(
          env.STRIPE_SECRET_KEY
        ),
        core_configured: Boolean(
          env.ONCE_CORE_URL
        )
      });
    }
    if (request.method === "GET" && url.pathname === "/activate/handoff") {
      return handleActivationHandoff(
        request,
        env
      );
    }
    if (request.method === "POST" && url.pathname === "/api/checkout") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json3(
          {
            error: "invalid_json"
          },
          400
        );
      }
      const planKey = String(
        body?.plan || ""
      ).trim().toLowerCase();
      const plan = getPlan(
        env,
        planKey
      );
      if (!plan) {
        return json3(
          {
            error: "invalid_plan"
          },
          400
        );
      }
      if (!env.SANDBOX_SESSION_SECRET) {
        return json3(
          {
            error: "sandbox_session_secret_missing"
          },
          503
        );
      }
      const result = await createStripeCheckoutSession({
        request,
        env,
        planKey,
        plan
      });
      if (!result.ok) {
        return result.response;
      }
      const sessionCookie = await createSandboxCookie(
        request,
        env,
        result.checkout.sandbox_session_id
      );
      const handoffUrl = await createActivationHandoff(
        request,
        env,
        result.checkout
      );
      return json3(
        {
          created: true,
          mode: "stripe_test",
          plan: result.checkout.plan,
          session_id: result.checkout.session_id,
          url: handoffUrl
        },
        200,
        {
          "set-cookie": sessionCookie
        }
      );
    }
    if (request.method === "POST" && url.pathname === "/api/claim") {
      if (!env.STRIPE_SECRET_KEY || !env.SANDBOX_SESSION_SECRET || !env.Q18_TRUTH || !env.SANDBOX_CLAIMS) {
        return json3(
          {
            error: "sandbox_provisioning_not_configured"
          },
          503
        );
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json3(
          {
            error: "invalid_json"
          },
          400
        );
      }
      const checkoutSessionId = String(
        body?.session_id || ""
      ).trim();
      if (!/^cs_test_[A-Za-z0-9_]+$/.test(
        checkoutSessionId
      )) {
        return json3(
          {
            error: "invalid_checkout_session"
          },
          400
        );
      }
      const cookie = await verifySandboxCookie(
        request,
        env
      );
      if (!cookie.ok) {
        return json3(
          {
            error: cookie.error
          },
          403
        );
      }
      const stripe = await retrieveStripeSession(
        env,
        checkoutSessionId
      );
      if (!stripe.ok) {
        if (stripe.status === 404) {
          return json3(
            {
              error: "checkout_session_not_found"
            },
            404
          );
        }
        return json3(
          {
            error: "stripe_session_verification_failed"
          },
          502
        );
      }
      const session = stripe.body || {};
      if (session.livemode !== false || session.mode !== "subscription" || session.status !== "complete") {
        return json3(
          {
            error: "checkout_session_not_complete"
          },
          403
        );
      }
      if (session.client_reference_id !== cookie.sandboxSessionId) {
        return json3(
          {
            error: "sandbox_session_mismatch"
          },
          403
        );
      }
      if (session?.metadata?.once_sandbox !== "true") {
        return json3(
          {
            error: "not_once_sandbox_checkout"
          },
          403
        );
      }
      const customerId = typeof session.customer === "string" ? session.customer : String(
        session?.customer?.id || ""
      );
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : String(
        session?.subscription?.id || ""
      );
      if (!customerId || !subscriptionId) {
        return json3(
          {
            error: "stripe_subscription_identity_missing"
          },
          409
        );
      }
      const truth = q18TruthStub(
        env
      );
      let entitlementResponse;
      try {
        entitlementResponse = await truth.fetch(
          new Request(
            "https://q18.internal/stripe/entitlement/" + encodeURIComponent(
              customerId
            ),
            {
              method: "GET"
            }
          )
        );
      } catch {
        return json3(
          {
            error: "entitlement_check_failed"
          },
          502
        );
      }
      if (entitlementResponse.status === 404) {
        return json3(
          {
            error: "entitlement_pending",
            message: "Stripe succeeded. Waiting for the Once entitlement webhook."
          },
          409
        );
      }
      let entitlement;
      try {
        entitlement = await entitlementResponse.json();
      } catch {
        return json3(
          {
            error: "invalid_entitlement_response"
          },
          502
        );
      }
      if (!entitlementResponse.ok) {
        return json3(
          {
            error: "entitlement_check_failed"
          },
          502
        );
      }
      const allowedStatuses = /* @__PURE__ */ new Set([
        "active",
        "trialing"
      ]);
      if (!allowedStatuses.has(
        entitlement.status
      )) {
        return json3(
          {
            error: "subscription_not_active",
            status: entitlement.status
          },
          403
        );
      }
      const expectedPlan = String(
        session?.metadata?.once_sandbox_plan || ""
      ).trim().toLowerCase();
      const entitlementPlan = String(
        entitlement.plan || ""
      ).trim().toLowerCase();
      if (expectedPlan && entitlementPlan && expectedPlan !== entitlementPlan) {
        return json3(
          {
            error: "subscription_plan_mismatch"
          },
          409
        );
      }
      const claimId = env.SANDBOX_CLAIMS.idFromName(
        "stripe-customer:" + customerId
      );
      const claimStub = env.SANDBOX_CLAIMS.get(
        claimId
      );
      return claimStub.fetch(
        new Request(
          "https://sandbox.internal/claim",
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              customer_id: customerId
            })
          }
        )
      );
    }
    if (request.method === "GET" && url.pathname === "/success") {
      const sessionId = String(
        url.searchParams.get(
          "session_id"
        ) || ""
      );
      if (!/^cs_test_[A-Za-z0-9_]+$/.test(
        sessionId
      )) {
        return html(
          "<h1>Invalid sandbox checkout return.</h1>",
          400
        );
      }
      return html(
        SUCCESS_PAGE
      );
    }
    if (request.method === "GET" && url.pathname === "/") {
      return html(PAGE);
    }
    return json3(
      {
        error: "not_found"
      },
      404
    );
  }
};
export {
  SandboxClaim,
  SandboxDemoEffect,
  index_default as default
};
//# sourceMappingURL=index.js.map
