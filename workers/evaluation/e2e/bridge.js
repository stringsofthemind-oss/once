function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function authorized(request, env) {
  const expected = String(env.E2E_TOKEN || "").trim();
  const supplied = String(request.headers.get("x-once-e2e-token") || "").trim();
  return expected.length >= 32 && supplied === expected;
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

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    return {
      error: "entitlement_lookup_failed",
      status: response.status,
      body,
    };
  }

  return body;
}

async function issueKey(env, customerId) {
  const id = env.SANDBOX_CLAIMS.idFromName(`stripe-customer:${customerId}`);
  const claim = env.SANDBOX_CLAIMS.get(id);
  const response = await claim.fetch(
    new Request("https://sandbox.internal/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ customer_id: customerId }),
    }),
  );

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) {
      return json({ error: "e2e_unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const customerId = String(env.E2E_CUSTOMER_ID || "").trim();

    if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) {
      return json({ error: "e2e_customer_invalid" }, 503);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        service: "once-evaluation-live-e2e-bridge",
        status: "online",
        customer_configured: true,
      });
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const entitlement = await readEntitlement(env, customerId);

      if (!entitlement) {
        return json({ error: "entitlement_not_ready" }, 409);
      }

      if (entitlement.error) {
        return json(entitlement, 502);
      }

      const entitlementStatus = String(entitlement.status || "").toLowerCase();
      if (!new Set(["active", "trialing"]).has(entitlementStatus)) {
        return json(
          {
            error: "entitlement_not_active",
            status: entitlementStatus || "unknown",
          },
          409,
        );
      }

      const claim = await issueKey(env, customerId);
      if (!claim.ok) {
        return json(
          {
            error: String(claim.body?.error || "key_claim_failed"),
            claim_status: claim.status,
          },
          claim.status || 502,
        );
      }

      if (!claim.body?.api_key) {
        return json({ error: "raw_key_missing" }, 409);
      }

      return json({
        ok: true,
        customer_id: customerId,
        entitlement_status: entitlementStatus,
        plan: entitlement.plan || claim.body.plan || null,
        api_key: claim.body.api_key,
        key_id: claim.body.key_id || null,
        monthly_limit: claim.body.monthly_limit || null,
      });
    }

    return json({ error: "not_found" }, 404);
  },
};
