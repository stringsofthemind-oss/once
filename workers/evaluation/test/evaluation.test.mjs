import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const EVALUATION_ID = "123e4567-e89b-42d3-a456-426614174000";

function makeEnv({
  enabled = true,
  stripeKey = "sk_test_once_eval",
  priceId = "price_eval_pro",
  entitlementFetch,
  claimFetch,
} = {}) {
  const entitlement = entitlementFetch || (async () => Response.json({
    found: true,
    customer_id: "cus_eval",
    subscription_id: "sub_eval",
    plan: "pro",
    status: "trialing",
    current_period_end: "2099-01-01T00:00:00.000Z",
  }));

  const claim = claimFetch || (async () => Response.json({
    created: true,
    status: "CLAIMED",
    key_id: "key_eval",
    api_key: "once_test_eval_key",
    customer_id: "cus_eval",
    plan: "pro",
    monthly_limit: 100000,
    warning: "Copy this API key now.",
  }));

  return {
    EVALUATION_BYPASS_ENABLED: enabled ? "true" : "false",
    STRIPE_SECRET_KEY: stripeKey,
    STRIPE_PRICE_PRO: priceId,
    Q18_TRUTH: {
      idFromName(name) {
        assert.equal(name, "once-q18-authoritative-ledger-v1");
        return "q18-id";
      },
      get(id) {
        assert.equal(id, "q18-id");
        return { fetch: entitlement };
      },
    },
    SANDBOX_CLAIMS: {
      idFromName(name) {
        assert.match(name, /^stripe-customer:/);
        return name;
      },
      get() {
        return { fetch: claim };
      },
    },
  };
}

function installStripeMock({
  customer = { id: "cus_eval", livemode: false },
  subscription = { id: "sub_eval", livemode: false, status: "trialing" },
} = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    const headers = new Headers(init.headers || {});
    const body = Object.fromEntries(new URLSearchParams(String(init.body || "")));
    calls.push({ url: requestUrl, method: init.method, headers, body });

    if (requestUrl.endsWith("/v1/customers")) {
      return Response.json(customer);
    }

    if (requestUrl.endsWith("/v1/subscriptions")) {
      return Response.json(subscription);
    }

    return Response.json({ error: { code: "unexpected_url" } }, { status: 404 });
  };

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function postEvaluate(env, evaluationId = EVALUATION_ID) {
  return worker.fetch(
    new Request("https://evaluate.onceexec.test/api/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluation_id: evaluationId }),
    }),
    env,
  );
}

test("feature flag OFF isolates the evaluation worker and performs no Stripe call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be called while disabled");
  };

  try {
    const response = await worker.fetch(
      new Request("https://evaluate.onceexec.test/"),
      makeEnv({ enabled: false }),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live Stripe keys are refused before activation", async () => {
  const response = await worker.fetch(
    new Request("https://evaluate.onceexec.test/"),
    makeEnv({ stripeKey: "sk_live_never_allowed" }),
  );

  assert.equal(response.status, 503);
  assert.match(await response.text(), /evaluation_requires_stripe_test_key/);
});

test("invalid evaluation identity is rejected before Stripe", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Stripe must not be reached for invalid identity");
  };

  try {
    const response = await postEvaluate(makeEnv(), "not-a-uuid");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_evaluation_id" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("happy path creates only test customer + one-day trial, waits for entitlement, then issues the normal key", async () => {
  const stripe = installStripeMock();

  try {
    const response = await postEvaluate(makeEnv());
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.activated, true);
    assert.equal(body.mode, "frictionless_stripe_test_trial");
    assert.equal(body.checkout_required, false);
    assert.equal(body.card_required, false);
    assert.equal(body.trial_duration_hours, 24);
    assert.equal(body.api_key, "once_test_eval_key");
    assert.equal(body.plan, "pro");
    assert.equal(body.monthly_limit, 100000);

    assert.equal(stripe.calls.length, 2);
    assert.ok(stripe.calls[0].url.endsWith("/v1/customers"));
    assert.ok(stripe.calls[1].url.endsWith("/v1/subscriptions"));
    assert.ok(stripe.calls.every((call) => !call.url.includes("checkout")));
    assert.ok(stripe.calls.every((call) => call.method === "POST"));
    assert.ok(stripe.calls.every((call) => call.headers.get("authorization") === "Bearer sk_test_once_eval"));

    assert.equal(stripe.calls[0].body["metadata[once_evaluation]"], "true");
    assert.equal(stripe.calls[0].body["metadata[once_evaluation_id]"], EVALUATION_ID);
    assert.equal(stripe.calls[1].body.customer, "cus_eval");
    assert.equal(stripe.calls[1].body["items[0][price]"], "price_eval_pro");
    assert.equal(stripe.calls[1].body.trial_period_days, "1");
    assert.equal(stripe.calls[1].body["trial_settings[end_behavior][missing_payment_method]"], "cancel");
    assert.equal(stripe.calls[1].body["metadata[plan]"], "pro");
  } finally {
    stripe.restore();
  }
});

test("retries reuse stable Stripe idempotency keys for the same evaluator", async () => {
  const stripe = installStripeMock();

  try {
    const first = await postEvaluate(makeEnv());
    const second = await postEvaluate(makeEnv());
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(stripe.calls.length, 4);

    const customerKeys = stripe.calls
      .filter((call) => call.url.endsWith("/v1/customers"))
      .map((call) => call.headers.get("idempotency-key"));
    const subscriptionKeys = stripe.calls
      .filter((call) => call.url.endsWith("/v1/subscriptions"))
      .map((call) => call.headers.get("idempotency-key"));

    assert.deepEqual(customerKeys, [
      `once-evaluation-customer-${EVALUATION_ID}`,
      `once-evaluation-customer-${EVALUATION_ID}`,
    ]);
    assert.deepEqual(subscriptionKeys, [
      `once-evaluation-subscription-${EVALUATION_ID}`,
      `once-evaluation-subscription-${EVALUATION_ID}`,
    ]);
  } finally {
    stripe.restore();
  }
});

test("missing entitlement fails closed as pending and never issues a key", async () => {
  const stripe = installStripeMock();
  const originalSetTimeout = globalThis.setTimeout;
  let claimCalls = 0;

  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 0;
  };

  try {
    const env = makeEnv({
      entitlementFetch: async () => Response.json({ error: "not_found" }, { status: 404 }),
      claimFetch: async () => {
        claimCalls += 1;
        return Response.json({ error: "must_not_be_called" }, { status: 500 });
      },
    });

    const response = await postEvaluate(env);
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "evaluation_entitlement_pending");
    assert.equal(claimCalls, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    stripe.restore();
  }
});

test("Stripe network ambiguity surfaces as an error instead of silently provisioning", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("simulated Stripe network failure");
  };

  try {
    const response = await postEvaluate(makeEnv());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "evaluation_stripe_network_error" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one-time key semantics fail closed on a second claim instead of fabricating a replacement key", async () => {
  const stripe = installStripeMock();
  let claimCalls = 0;

  const env = makeEnv({
    claimFetch: async () => {
      claimCalls += 1;
      if (claimCalls === 1) {
        return Response.json({
          created: true,
          status: "CLAIMED",
          key_id: "key_eval",
          api_key: "once_test_eval_key",
          customer_id: "cus_eval",
          plan: "pro",
          monthly_limit: 100000,
        });
      }

      return Response.json({
        created: false,
        already_claimed: true,
        status: "CLAIMED",
        key_id: "key_eval",
        customer_id: "cus_eval",
        plan: "pro",
        monthly_limit: 100000,
        warning: "The raw API key was already shown once and is not recoverable.",
      });
    },
  });

  try {
    const first = await postEvaluate(env);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).api_key, "once_test_eval_key");

    const second = await postEvaluate(env);
    assert.equal(second.status, 502);
    assert.deepEqual(await second.json(), { error: "evaluation_key_already_issued" });
    assert.equal(claimCalls, 2);
  } finally {
    stripe.restore();
  }
});
