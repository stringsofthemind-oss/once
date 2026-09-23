const ADMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const ADMISSION_OBJECT_NAME = "once-evaluation-admission-v1";
const DEFAULT_MAX_PER_CLIENT_24H = 3;
const DEFAULT_GLOBAL_MAX_24H = 100;

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function validateEvaluationId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id
    : null;
}

function configuredLimit(value, fallback, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    return null;
  }

  return parsed;
}

function retryAfterSeconds(starts, now) {
  if (!starts.length) return 1;
  const oldest = Math.min(...starts);
  return Math.max(1, Math.ceil((oldest + ADMISSION_WINDOW_MS - now) / 1000));
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
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function assertAdmissionConfiguration(env) {
  if (!env.EVALUATION_ADMISSION) {
    throw new Error("evaluation_admission_binding_missing");
  }

  const secret = String(env.EVALUATION_ADMISSION_SECRET || "");
  if (secret.length < 32) {
    throw new Error("evaluation_admission_secret_missing");
  }

  if (configuredLimit(env.EVALUATION_MAX_PER_CLIENT_24H, DEFAULT_MAX_PER_CLIENT_24H, 100) === null) {
    throw new Error("evaluation_client_limit_invalid");
  }

  if (configuredLimit(env.EVALUATION_GLOBAL_MAX_24H, DEFAULT_GLOBAL_MAX_24H, 100000) === null) {
    throw new Error("evaluation_global_limit_invalid");
  }
}

function admissionStub(env) {
  const id = env.EVALUATION_ADMISSION.idFromName(ADMISSION_OBJECT_NAME);
  return env.EVALUATION_ADMISSION.get(id);
}

export async function enforceEvaluationAdmission(request, env, evaluationId) {
  const clientAddress = String(request.headers.get("cf-connecting-ip") || "").trim();
  if (!clientAddress) {
    return json(
      {
        error: "evaluation_client_identity_unavailable",
        message: "Evaluation admission requires a Cloudflare client identity.",
      },
      403,
    );
  }

  const clientKey = await hmacHex(
    String(env.EVALUATION_ADMISSION_SECRET),
    `once-evaluation-client:${clientAddress}`,
  );

  const response = await admissionStub(env).fetch(
    new Request("https://evaluation.internal/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evaluation_id: evaluationId,
        client_key: clientKey,
      }),
    }),
  );

  let body;
  try {
    body = await response.json();
  } catch {
    return json({ error: "evaluation_admission_invalid_response" }, 503);
  }

  if (response.ok && body?.allowed === true) {
    return null;
  }

  const retryAfter = response.headers.get("retry-after");
  return json(
    body && typeof body === "object"
      ? body
      : { error: "evaluation_admission_denied" },
    response.status >= 400 ? response.status : 503,
    retryAfter ? { "retry-after": retryAfter } : {},
  );
}

export class EvaluationAdmission {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/admit") {
      return json({ error: "not_found" }, 404);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const evaluationId = validateEvaluationId(body?.evaluation_id);
    const clientKey = String(body?.client_key || "").trim().toLowerCase();

    if (!evaluationId || !/^[0-9a-f]{64}$/.test(clientKey)) {
      return json({ error: "evaluation_admission_identity_invalid" }, 400);
    }

    const maxPerClient = configuredLimit(
      this.env.EVALUATION_MAX_PER_CLIENT_24H,
      DEFAULT_MAX_PER_CLIENT_24H,
      100,
    );
    const globalMax = configuredLimit(
      this.env.EVALUATION_GLOBAL_MAX_24H,
      DEFAULT_GLOBAL_MAX_24H,
      100000,
    );

    if (maxPerClient === null || globalMax === null) {
      return json({ error: "evaluation_admission_configuration_invalid" }, 503);
    }

    const now = Date.now();
    const cutoff = now - ADMISSION_WINDOW_MS;
    const evaluationKey = `evaluation:${evaluationId}`;
    const clientStartsKey = `client:${clientKey}`;
    const globalStartsKey = "global:starts";

    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get(evaluationKey);

      if (existing) {
        if (existing.client_key !== clientKey) {
          return json(
            {
              error: "evaluation_identity_mismatch",
              message: "This evaluation ID is already bound to a different client.",
            },
            409,
          );
        }

        if (Number(existing.expires_at || 0) <= now) {
          return json(
            {
              error: "evaluation_expired",
              message: "This evaluation ID has expired. Start a new evaluation if admission capacity allows.",
            },
            410,
          );
        }

        return json({
          allowed: true,
          retry: true,
          evaluation_expires_at: new Date(existing.expires_at).toISOString(),
        });
      }

      const storedClientStarts = await txn.get(clientStartsKey);
      const storedGlobalStarts = await txn.get(globalStartsKey);
      const clientStarts = Array.isArray(storedClientStarts)
        ? storedClientStarts.filter((value) => Number(value) > cutoff)
        : [];
      const globalStarts = Array.isArray(storedGlobalStarts)
        ? storedGlobalStarts.filter((value) => Number(value) > cutoff)
        : [];

      if (clientStarts.length >= maxPerClient) {
        const retryAfter = retryAfterSeconds(clientStarts, now);
        await txn.put(clientStartsKey, clientStarts);
        return json(
          {
            error: "evaluation_rate_limited",
            message: "This client has reached the 24-hour evaluation admission limit.",
          },
          429,
          { "retry-after": String(retryAfter) },
        );
      }

      if (globalStarts.length >= globalMax) {
        const retryAfter = retryAfterSeconds(globalStarts, now);
        await txn.put(globalStartsKey, globalStarts);
        return json(
          {
            error: "evaluation_capacity_reached",
            message: "Evaluation capacity is temporarily exhausted. Try again later.",
          },
          429,
          { "retry-after": String(retryAfter) },
        );
      }

      const expiresAt = now + ADMISSION_WINDOW_MS;
      clientStarts.push(now);
      globalStarts.push(now);

      await txn.put(evaluationKey, {
        client_key: clientKey,
        admitted_at: now,
        expires_at: expiresAt,
      });
      await txn.put(clientStartsKey, clientStarts);
      await txn.put(globalStartsKey, globalStarts);

      return json({
        allowed: true,
        retry: false,
        evaluation_expires_at: new Date(expiresAt).toISOString(),
      });
    });
  }
}
