var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
import { DurableObject } from "cloudflare:workers";
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
__name(json, "json");
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep, "sleep");
function stripeTimingSafeHexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}
__name(stripeTimingSafeHexEqual, "stripeTimingSafeHexEqual");
async function verifyStripeWebhookSignature(payload, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader || !secret) {
    return false;
  }
  const parts = signatureHeader.split(",").map((part) => part.trim());
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key2 = part.slice(
      0,
      separator
    ).trim();
    const value = part.slice(
      separator + 1
    ).trim();
    if (key2 === "t") {
      timestamp = value;
    }
    if (key2 === "v1") {
      signatures.push(
        value.toLowerCase()
      );
    }
  }
  if (!timestamp || signatures.length === 0) {
    return false;
  }
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(
    timestampNumber
  )) {
    return false;
  }
  const currentSeconds = Math.floor(
    Date.now() / 1e3
  );
  if (Math.abs(
    currentSeconds - timestampNumber
  ) > toleranceSeconds) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    [
      "sign"
    ]
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      `${timestamp}.${payload}`
    )
  );
  const expected = Array.from(
    new Uint8Array(
      signatureBuffer
    )
  ).map(
    (byte) => byte.toString(16).padStart(
      2,
      "0"
    )
  ).join("");
  return signatures.some(
    (candidate) => stripeTimingSafeHexEqual(
      candidate,
      expected
    )
  );
}
__name(verifyStripeWebhookSignature, "verifyStripeWebhookSignature");
var ONCE_PLAN_LIMITS = Object.freeze({
  pro: 1e5,
  startup: 5e5,
  scale: 2e6
});
async function onceSha256Hex(value) {
  const data = new TextEncoder().encode(
    String(value)
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data
  );
  return Array.from(
    new Uint8Array(
      digest
    )
  ).map(
    (byte) => byte.toString(16).padStart(
      2,
      "0"
    )
  ).join("");
}
__name(onceSha256Hex, "onceSha256Hex");
function onceRandomHex(byteLength = 32) {
  const bytes = new Uint8Array(
    byteLength
  );
  crypto.getRandomValues(
    bytes
  );
  return Array.from(bytes).map(
    (byte) => byte.toString(16).padStart(
      2,
      "0"
    )
  ).join("");
}
__name(onceRandomHex, "onceRandomHex");
async function onceTenantScopedOperationId(customerId, operationId) {
  const material = "once:v1:" + String(customerId) + ":" + String(operationId);
  const digest = await onceSha256Hex(
    material
  );
  return "tenant_v1_" + digest;
}
__name(onceTenantScopedOperationId, "onceTenantScopedOperationId");
function onceCanonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(
      (item) => onceCanonicalJson(
        item
      )
    ).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map(
    (key) => JSON.stringify(key) + ":" + onceCanonicalJson(
      value[key]
    )
  ).join(",") + "}";
}
__name(onceCanonicalJson, "onceCanonicalJson");
async function onceSemanticHash(providerName, action) {
  const material = "once:semantic:v1\n" + String(providerName) + "\n" + onceCanonicalJson(action);
  return await onceSha256Hex(
    material
  );
}
__name(onceSemanticHash, "onceSemanticHash");
// An absent field, coercible value, or contradictory receipt is UNKNOWN,
// never evidence of absence. Providers must implement this explicit contract.
function onceValidateProviderObservation(data, operationId) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      typeof data.provider_executed !== "boolean" ||
      !Number.isSafeInteger(data.side_effects) || data.side_effects < 0 ||
      data.provider_executed !== (data.side_effects > 0) ||
      (data.operation_id !== undefined && data.operation_id !== operationId)) {
    throw new Error("provider_observation_invalid");
  }
  if (data.side_effects > 1) {
    throw new Error("provider_duplicate_effects_detected");
  }
  return data.side_effects;
}

var Q18Truth = class extends DurableObject {
  static {
    __name(this, "Q18Truth");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS operations (
				operation_id TEXT PRIMARY KEY,
				attempts INTEGER NOT NULL,
				state TEXT NOT NULL,
				first_attempt_at TEXT NOT NULL,
				last_attempt_at TEXT NOT NULL
			)
		`);
    let operationColumns = [
      ...this.ctx.storage.sql.exec(`
				PRAGMA table_info(operations)
			`)
    ].map((row) => row.name);
    if (!operationColumns.includes("state")) {
      this.ctx.storage.sql.exec(`
				ALTER TABLE operations
				ADD COLUMN state TEXT NOT NULL
				DEFAULT 'CONFIRMED'
			`);
      operationColumns.push("state");
    }
    if (!operationColumns.includes("first_attempt_at")) {
      this.ctx.storage.sql.exec(`
				ALTER TABLE operations
				ADD COLUMN first_attempt_at TEXT
			`);
      operationColumns.push("first_attempt_at");
      if (operationColumns.includes(
        "first_executed_at"
      )) {
        this.ctx.storage.sql.exec(`
					UPDATE operations
					SET first_attempt_at =
						first_executed_at
					WHERE first_attempt_at IS NULL
				`);
      } else {
        const migrationTime = (/* @__PURE__ */ new Date()).toISOString();
        this.ctx.storage.sql.exec(`
					UPDATE operations
					SET first_attempt_at = ?
					WHERE first_attempt_at IS NULL
				`, migrationTime);
      }
    }
    if (!operationColumns.includes("last_attempt_at")) {
      this.ctx.storage.sql.exec(`
				ALTER TABLE operations
				ADD COLUMN last_attempt_at TEXT
			`);
      operationColumns.push("last_attempt_at");
      this.ctx.storage.sql.exec(`
				UPDATE operations
				SET last_attempt_at =
					first_attempt_at
				WHERE last_attempt_at IS NULL
			`);
    }
    const repairTime = (/* @__PURE__ */ new Date()).toISOString();
    this.ctx.storage.sql.exec(`
			UPDATE operations
			SET first_attempt_at = ?
			WHERE first_attempt_at IS NULL
		`, repairTime);
    this.ctx.storage.sql.exec(`
			UPDATE operations
			SET last_attempt_at =
				first_attempt_at
			WHERE last_attempt_at IS NULL
		`);
    this.hasLegacySideEffects = operationColumns.includes(
      "side_effects"
    );
    this.hasLegacyFirstExecutedAt = operationColumns.includes(
      "first_executed_at"
    );
    this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS provider_effects (
				operation_id TEXT PRIMARY KEY,
				side_effects INTEGER NOT NULL,
				executed_at TEXT NOT NULL
			)
		`);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS confirmation_receipts (
                          operation_id TEXT PRIMARY KEY,
                          provider TEXT NOT NULL,
                          side_effects INTEGER NOT NULL
                                  CHECK(side_effects = 1),
                          executed_at TEXT,
                          confirmed_at TEXT NOT NULL
                  )
          `);
    this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS http_response_replays (
				operation_id TEXT PRIMARY KEY,
				status INTEGER NOT NULL,
				body_text TEXT NOT NULL,
				headers_json TEXT NOT NULL,
				recorded_at TEXT NOT NULL
			)
		`);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS http_replay_requirements (
                          operation_id TEXT PRIMARY KEY,
                          required_at TEXT NOT NULL
                  )
          `);
    if (this.hasLegacySideEffects && this.hasLegacyFirstExecutedAt) {
      this.ctx.storage.sql.exec(`
				INSERT OR IGNORE INTO
					provider_effects (
						operation_id,
						side_effects,
						executed_at
					)
				SELECT
					operation_id,
					side_effects,
					first_executed_at
				FROM operations
				WHERE
					side_effects > 0
					AND first_executed_at
						IS NOT NULL
			`);
    }
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS stripe_events (
                          event_id TEXT PRIMARY KEY,
                          type TEXT NOT NULL,
                          processed_at TEXT NOT NULL
                  )
          `);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS stripe_entitlements (
                          customer_id TEXT PRIMARY KEY,
                          subscription_id TEXT NOT NULL,
                          plan TEXT NOT NULL,
                          status TEXT NOT NULL,
                          price_id TEXT,
                          current_period_end TEXT,
                          updated_at TEXT NOT NULL
                  )
          `);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS api_keys (
                          key_id TEXT PRIMARY KEY,
                          key_hash TEXT NOT NULL UNIQUE,
                          customer_id TEXT NOT NULL,
                          created_at TEXT NOT NULL,
                          revoked_at TEXT
                  )
          `);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS usage_monthly (
                          customer_id TEXT NOT NULL,
                          period_key TEXT NOT NULL,
                          used INTEGER NOT NULL DEFAULT 0,
                          updated_at TEXT NOT NULL,

                          PRIMARY KEY (
                                  customer_id,
                                  period_key
                          )
                  )
          `);
    if (!operationColumns.includes("provider")) {
      this.ctx.storage.sql.exec(`
                            ALTER TABLE operations
                            ADD COLUMN provider TEXT NOT NULL
                            DEFAULT 'blind_test'
                    `);
      operationColumns.push("provider");
    }
    this.ctx.storage.sql.exec(`
                    UPDATE operations
                    SET provider = 'blind_test'
                    WHERE
                            provider IS NULL
                            OR TRIM(provider) = ''
            `);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS usage_operations (
                          customer_id TEXT NOT NULL,
                          period_key TEXT NOT NULL,
                          operation_id TEXT NOT NULL,
                          created_at TEXT NOT NULL,

                          PRIMARY KEY (
                                  customer_id,
                                  period_key,
                                  operation_id
                          )
                  )
          `);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS execute_rate_limits (
                          customer_id TEXT NOT NULL,
                          window_key INTEGER NOT NULL,
                          request_count INTEGER NOT NULL DEFAULT 0,
                          updated_at TEXT NOT NULL,

                          PRIMARY KEY (
                                  customer_id,
                                  window_key
                          )
                  )
          `);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS unknown_reconciliation (
                          operation_id TEXT PRIMARY KEY,
                          checks INTEGER NOT NULL DEFAULT 0,
                          next_check_at INTEGER NOT NULL,
                          created_at TEXT NOT NULL,
                          updated_at TEXT NOT NULL,
                          exhausted_at TEXT
                  )
          `);
    const reconciliationColumnsV1 = [
      ...this.ctx.storage.sql.exec(`
                          PRAGMA table_info(unknown_reconciliation)
                  `)
    ].map((row) => row.name);
    if (!reconciliationColumnsV1.includes(
      "exhausted_at"
    )) {
      this.ctx.storage.sql.exec(`
                          ALTER TABLE unknown_reconciliation
                          ADD COLUMN exhausted_at TEXT
                  `);
    }
    this.ctx.storage.sql.exec(`
                  INSERT OR IGNORE INTO unknown_reconciliation (
                          operation_id,
                          checks,
                          next_check_at,
                          created_at,
                          updated_at
                  )
                  SELECT
                          operation_id,
                          0,
                          0,
                          CURRENT_TIMESTAMP,
                          CURRENT_TIMESTAMP
                  FROM operations
                  WHERE state = 'UNKNOWN'
          `);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS operation_semantics (
                          customer_id TEXT NOT NULL,
                          operation_id TEXT NOT NULL,
                          provider TEXT NOT NULL,
                          semantic_hash TEXT NOT NULL,
                          created_at TEXT NOT NULL,

                          PRIMARY KEY (
                                  customer_id,
                                  operation_id
                          )
                  )
          `);
    const operationSemanticColumns = [
      ...this.ctx.storage.sql.exec(
        `PRAGMA table_info(operation_semantics)`
      )
    ].map(
      (row) => String(row.name)
    );
    if (!operationSemanticColumns.includes(
      "resolved_provider"
    )) {
      this.ctx.storage.sql.exec(`
                          ALTER TABLE operation_semantics
                          ADD COLUMN resolved_provider TEXT
                  `);
    }
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS provider_versions (
                          version_id TEXT PRIMARY KEY,
                          customer_id TEXT NOT NULL,
                          provider_name TEXT NOT NULL,
                          provider_type TEXT NOT NULL,
                          encrypted_config TEXT NOT NULL,
                          iv_b64 TEXT NOT NULL,
                          key_version INTEGER NOT NULL DEFAULT 1,
                          created_at TEXT NOT NULL
                  )
          `);
    this.ctx.storage.sql.exec(`
                  CREATE INDEX IF NOT EXISTS idx_provider_versions_customer
                  ON provider_versions (
                          customer_id,
                          provider_name
                  )
          `);
    this.ctx.storage.sql.exec(`
                  CREATE TABLE IF NOT EXISTS provider_aliases (
                          customer_id TEXT NOT NULL,
                          provider_name TEXT NOT NULL,
                          current_version_id TEXT NOT NULL,
                          created_at TEXT NOT NULL,
                          updated_at TEXT NOT NULL,
                          disabled_at TEXT,

                          PRIMARY KEY (
                                  customer_id,
                                  provider_name
                          )
                  )
          `);
  }
  // ==========================================================
  // ==========================================================
  // HTTP RESPONSE REPLAY HELPERS v0.1
  // ==========================================================
  //
  // Replay records are immutable once written.
  //
  // Body limit:
  //   1 MiB UTF-8
  //
  // Header limit:
  //   16 KiB JSON
  //
  // Only explicitly approved response headers are retained.
  // Sensitive request/auth/cookie material is never accepted
  // merely because it appeared in an HTTP response.
  // ==========================================================
  sanitizeHttpResponseReplayHeaders(headers = {}) {
    const allowed = /* @__PURE__ */ new Set([
      "cache-control",
      "content-language",
      "content-type",
      "etag",
      "expires",
      "last-modified",
      "location",
      "request-id",
      "retry-after",
      "x-correlation-id",
      "x-request-id"
    ]);
    let normalized;
    try {
      normalized = new Headers(headers);
    } catch {
      throw new Error(
        "http_response_replay_invalid_headers"
      );
    }
    const safe = {};
    for (const [name, value] of normalized.entries()) {
      const key = String(name).trim().toLowerCase();
      if (!allowed.has(key)) {
        continue;
      }
      safe[key] = String(value);
    }
    return safe;
  }
  getHttpResponseReplay(operationId) {
    const normalizedOperationId = String(operationId || "").trim();
    if (!normalizedOperationId) {
      throw new Error(
        "http_response_replay_operation_id_required"
      );
    }
    const row = [
      ...this.ctx.storage.sql.exec(
        `
				SELECT
					operation_id,
					status,
					body_text,
					headers_json,
					recorded_at
				FROM http_response_replays
				WHERE operation_id = ?
				LIMIT 1
				`,
        normalizedOperationId
      )
    ][0];
    if (!row) {
      return void 0;
    }
    let headers;
    try {
      headers = JSON.parse(
        String(row.headers_json)
      );
    } catch {
      throw new Error(
        "http_response_replay_corrupt_headers"
      );
    }
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
      throw new Error(
        "http_response_replay_corrupt_headers"
      );
    }
    return {
      operation_id: normalizedOperationId,
      status: Number(row.status),
      body_text: String(row.body_text),
      headers,
      recorded_at: String(row.recorded_at)
    };
  }
  recordHttpResponseReplay(operationId, {
    status,
    bodyText = "",
    headers = {},
    recordedAt = (/* @__PURE__ */ new Date()).toISOString()
  } = {}) {
    const normalizedOperationId = String(operationId || "").trim();
    if (!normalizedOperationId) {
      throw new Error(
        "http_response_replay_operation_id_required"
      );
    }
    const normalizedStatus = Number(status);
    if (!Number.isInteger(normalizedStatus) || normalizedStatus < 100 || normalizedStatus > 599) {
      throw new Error(
        "http_response_replay_invalid_status"
      );
    }
    const normalizedBody = String(bodyText ?? "");
    const bodyBytes = new TextEncoder().encode(
      normalizedBody
    ).byteLength;
    if (bodyBytes > 1048576) {
      throw new Error(
        "http_response_replay_body_too_large"
      );
    }
    const safeHeaders = this.sanitizeHttpResponseReplayHeaders(
      headers
    );
    const orderedHeaders = Object.fromEntries(
      Object.entries(safeHeaders).sort(
        ([a], [b]) => a.localeCompare(b)
      )
    );
    const headersJson = JSON.stringify(
      orderedHeaders
    );
    const headerBytes = new TextEncoder().encode(
      headersJson
    ).byteLength;
    if (headerBytes > 16384) {
      throw new Error(
        "http_response_replay_headers_too_large"
      );
    }
    const normalizedRecordedAt = String(recordedAt || "").trim();
    if (!normalizedRecordedAt) {
      throw new Error(
        "http_response_replay_recorded_at_required"
      );
    }
    const existing = this.getHttpResponseReplay(
      normalizedOperationId
    );
    if (existing) {
      const existingHeadersJson = JSON.stringify(
        Object.fromEntries(
          Object.entries(
            existing.headers
          ).sort(
            ([a], [b]) => a.localeCompare(b)
          )
        )
      );
      if (existing.status === normalizedStatus && existing.body_text === normalizedBody && existingHeadersJson === headersJson) {
        return existing;
      }
      throw new Error(
        "http_response_replay_conflict"
      );
    }
    this.ctx.storage.sql.exec(
      `
			INSERT INTO http_response_replays (
				operation_id,
				status,
				body_text,
				headers_json,
				recorded_at
			)
			VALUES (?, ?, ?, ?, ?)
			`,
      normalizedOperationId,
      normalizedStatus,
      normalizedBody,
      headersJson,
      normalizedRecordedAt
    );
    return this.getHttpResponseReplay(
      normalizedOperationId
    );
  }
  // ==========================================================
  // HTTP RESPONSE REPLAY REQUIREMENT HELPERS v0.1
  // ==========================================================
  isHttpResponseReplayRequired(operationId) {
    const normalizedOperationId = String(operationId || "").trim();
    if (!normalizedOperationId) {
      throw new Error(
        "http_replay_requirement_operation_id_required"
      );
    }
    const row = [
      ...this.ctx.storage.sql.exec(
        `
                          SELECT operation_id
                          FROM http_replay_requirements
                          WHERE operation_id = ?
                          LIMIT 1
                          `,
        normalizedOperationId
      )
    ][0];
    return Boolean(row);
  }
  requireHttpResponseReplay(operationId, requiredAt = (/* @__PURE__ */ new Date()).toISOString()) {
    const normalizedOperationId = String(operationId || "").trim();
    const normalizedRequiredAt = String(requiredAt || "").trim();
    if (!normalizedOperationId) {
      throw new Error(
        "http_replay_requirement_operation_id_required"
      );
    }
    if (!normalizedRequiredAt) {
      throw new Error(
        "http_replay_requirement_required_at_required"
      );
    }
    this.ctx.storage.sql.exec(
      `
                  INSERT OR IGNORE INTO http_replay_requirements (
                          operation_id,
                          required_at
                  )
                  VALUES (?, ?)
                  `,
      normalizedOperationId,
      normalizedRequiredAt
    );
    return this.isHttpResponseReplayRequired(
      normalizedOperationId
    );
  }
  // INSERT OPERATION ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â SCHEMA COMPATIBILITY LAYER
  // ==========================================================
  //
  // This method is the important compatibility fix.
  //
  // It allows the same Worker code to operate against:
  //
  // 1. brand-new Q18 databases
  // 2. original legacy Q18 databases
  // 3. partially migrated Q18 databases
  //
  // Legacy side_effects is inserted as 0 because provider_effects
  // is now the authoritative provider ledger.
  // ==========================================================
  // ONCE SAFE STRUCTURED OBSERVABILITY
  // ==========================================================
  //
  // Never logs secrets, raw operation IDs, request bodies,
  // Authorization headers, API keys, or action payloads.
  //
  // Logging failure must never affect execution safety.
  //
  async onceLog(event, fields = {}) {
    try {
      const safeString = /* @__PURE__ */ __name((value, maxLength = 96) => String(
        value ?? ""
      ).slice(
        0,
        maxLength
      ), "safeString");
      const entry = {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        event: safeString(
          event,
          96
        )
      };
      if (fields.operationId !== void 0 && fields.operationId !== null) {
        entry.operation_ref = (await onceSha256Hex(
          "once:observability:v1:" + String(
            fields.operationId
          )
        )).slice(
          0,
          24
        );
      }
      if (fields.provider !== void 0) {
        entry.provider = safeString(
          fields.provider,
          64
        );
      }
      if (fields.state !== void 0) {
        entry.state = safeString(
          fields.state,
          32
        );
      }
      if (fields.result !== void 0) {
        entry.result = safeString(
          fields.result,
          64
        );
      }
      if (Number.isFinite(
        Number(
          fields.attempts
        )
      )) {
        entry.attempts = Math.max(
          0,
          Math.trunc(
            Number(
              fields.attempts
            )
          )
        );
      }
      if (Number.isFinite(
        Number(
          fields.status
        )
      )) {
        entry.status = Math.trunc(
          Number(
            fields.status
          )
        );
      }
      console.log(
        JSON.stringify(
          entry
        )
      );
    } catch {
      try {
        console.log(
          JSON.stringify(
            {
              timestamp: (/* @__PURE__ */ new Date()).toISOString(),
              event: "once.observability.error"
            }
          )
        );
      } catch {
      }
    }
  }
  insertOperation(operationId, state, now, providerName = "blind_test") {
    const operationProvider = String(
      providerName || "blind_test"
    ).trim().toLowerCase();
    if (this.hasLegacySideEffects && this.hasLegacyFirstExecutedAt) {
      this.ctx.storage.sql.exec(
        `
				INSERT INTO operations (
					operation_id,
					provider,
					attempts,
					side_effects,
					first_executed_at,
					last_attempt_at,
					state,
					first_attempt_at
				)
				VALUES (
					?,
					?,
					1,
					0,
					?,
					?,
					?,
					?
				)
				`,
        operationId,
        operationProvider,
        now,
        now,
        state,
        now
      );
      return;
    }
    if (this.hasLegacySideEffects) {
      this.ctx.storage.sql.exec(
        `
				INSERT INTO operations (
					operation_id,
					provider,
					attempts,
					side_effects,
					state,
					first_attempt_at,
					last_attempt_at
				)
				VALUES (
					?,
					?,
					1,
					0,
					?,
					?,
					?
				)
				`,
        operationId,
        operationProvider,
        state,
        now,
        now
      );
      return;
    }
    if (this.hasLegacyFirstExecutedAt) {
      this.ctx.storage.sql.exec(
        `
				INSERT INTO operations (
					operation_id,
					provider,
					attempts,
					first_executed_at,
					state,
					first_attempt_at,
					last_attempt_at
				)
				VALUES (
					?,
					?,
					1,
					?,
					?,
					?,
					?
				)
				`,
        operationId,
        operationProvider,
        now,
        state,
        now,
        now
      );
      return;
    }
    this.ctx.storage.sql.exec(
      `
			INSERT INTO operations (
				operation_id,
				provider,
				attempts,
				state,
				first_attempt_at,
				last_attempt_at
			)
			VALUES (
				?,
				?,
				1,
				?,
				?,
				?
			)
			`,
      operationId,
      operationProvider,
      state,
      now,
      now
    );
  }
  // ==========================================================
  // READ OPERATION
  // ==========================================================
  getOperation(operationId) {
    return [
      ...this.ctx.storage.sql.exec(
        `
				SELECT *
				FROM operations
				WHERE operation_id = ?
				`,
        operationId
      )
    ][0];
  }
  // ==========================================================
  // DURABLE CONFIRMATION RECEIPTS
  // ==========================================================
  //
  // A receipt is written only after authoritative provider proof
  // or successful provider execution has established exactly one
  // external effect.
  //
  // Receipt absence NEVER authorizes execution.
  // Receipt presence is only a replay/suppression optimisation.
  // ==========================================================
  getConfirmationReceipt(operationId) {
    const normalizedOperationId = String(
      operationId || ""
    ).trim();

    if (!normalizedOperationId) {
      throw new Error(
        "confirmation_receipt_operation_id_required"
      );
    }

    const row = [
      ...this.ctx.storage.sql.exec(
        `
                  SELECT
                          operation_id,
                          provider,
                          side_effects,
                          executed_at,
                          confirmed_at
                  FROM confirmation_receipts
                  WHERE operation_id = ?
                  LIMIT 1
                  `,
        normalizedOperationId
      )
    ][0];

    if (!row) {
      return void 0;
    }

    const sideEffects = Number(
      row.side_effects
    );

    if (sideEffects !== 1) {
      throw new Error(
        "confirmation_receipt_invalid_side_effects"
      );
    }

    return {
      operation_id:
        normalizedOperationId,

      provider:
        String(
          row.provider || ""
        ).trim().toLowerCase(),

      side_effects:
        sideEffects,

      executed_at:
        row.executed_at === null ||
        row.executed_at === void 0
          ? null
          : String(
              row.executed_at
            ),

      confirmed_at:
        String(
          row.confirmed_at
        )
    };
  }

  recordConfirmationReceipt(
    operationId,
    providerName,
    proof,
    confirmedAt =
      (new Date()).toISOString()
  ) {
    const normalizedOperationId =
      String(
        operationId || ""
      ).trim();

    const normalizedProvider =
      String(
        providerName || ""
      ).trim().toLowerCase();

    const sideEffects =
      Number(
        proof?.side_effects
      );

    const normalizedConfirmedAt =
      String(
        confirmedAt || ""
      ).trim();

    if (!normalizedOperationId) {
      throw new Error(
        "confirmation_receipt_operation_id_required"
      );
    }

    if (!normalizedProvider) {
      throw new Error(
        "confirmation_receipt_provider_required"
      );
    }

    if (sideEffects !== 1) {
      throw new Error(
        "confirmation_receipt_requires_one_effect"
      );
    }

    if (!normalizedConfirmedAt) {
      throw new Error(
        "confirmation_receipt_confirmed_at_required"
      );
    }

    const rawExecutedAt =
      proof?.executed_at ??
      proof?.first_executed_at ??
      null;

    const executedAt =
      rawExecutedAt === null ||
      rawExecutedAt === void 0
        ? null
        : String(
            rawExecutedAt
          );

    const existing =
      this.getConfirmationReceipt(
        normalizedOperationId
      );

    if (existing) {
      if (
        existing.provider !==
          normalizedProvider ||
        existing.side_effects !== 1
      ) {
        throw new Error(
          "confirmation_receipt_conflict"
        );
      }

      return existing;
    }

    this.ctx.storage.sql.exec(
      `
                  INSERT INTO confirmation_receipts (
                          operation_id,
                          provider,
                          side_effects,
                          executed_at,
                          confirmed_at
                  )
                  VALUES (?, ?, 1, ?, ?)
                  `,
      normalizedOperationId,
      normalizedProvider,
      executedAt,
      normalizedConfirmedAt
    );

    return this.getConfirmationReceipt(
      normalizedOperationId
    );
  }

  // ==========================================================
  // READ INDEPENDENT EXTERNAL PROVIDER TRUTH
  // ==========================================================
  async getBlindTestProvider(operationId) {
    const response = await fetch(
      "https://q18-blind-provider.pennywatch.workers.dev/truth/" + encodeURIComponent(operationId),
      {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        method: "GET"
      }
    );
    if (!response.ok) {
      throw new Error(
        "provider_truth_http_" + response.status
      );
    }
    const data = await response.json();
    const sideEffects = onceValidateProviderObservation(data, operationId);
    if (sideEffects === 0) {
      return void 0;
    }
    return {
      operation_id: operationId,
      side_effects: Number(
        data.side_effects || 0
      ),
      executed_at: data.first_executed_at || data.last_executed_at || null,
      first_executed_at: data.first_executed_at || null,
      last_executed_at: data.last_executed_at || null
    };
  }
  // ==========================================================
  // EXECUTE AGAINST INDEPENDENT BLIND PROVIDER
  // ==========================================================
  async executeBlindTestProvider(operationId) {
    const response = await fetch(
      "https://q18-blind-provider.pennywatch.workers.dev/execute",
      {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          operation_id: operationId
        })
      }
    );
    if (!response.ok) {
      throw new Error(
        "provider_execute_http_" + response.status
      );
    }
    const data = await response.json();
    if (onceValidateProviderObservation(data, operationId) !== 1) {
      throw new Error("provider_execute_unconfirmed");
    }
    return {
      operation_id: operationId,
      side_effects: Number(
        data.side_effects || 0
      ),
      executed_at: data.first_executed_at || data.last_executed_at || null,
      first_executed_at: data.first_executed_at || null,
      last_executed_at: data.last_executed_at || null
    };
  }
  // ==========================================================
  // ==============================================================
  // ==============================================================
  // ==============================================================
  // CUSTOMER PROVIDER CONFIG CRYPTO
  // ==============================================================
  providerBytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }
  providerBase64ToBytes(value) {
    const binary = atob(String(value));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  getProviderMasterKeyBytes() {
    const encoded = String(
      this.env?.ONCE_PROVIDER_MASTER_KEY || ""
    ).trim();
    if (!encoded) {
      throw new Error(
        "provider_master_key_missing"
      );
    }
    let bytes;
    try {
      bytes = this.providerBase64ToBytes(
        encoded
      );
    } catch {
      throw new Error(
        "provider_master_key_invalid"
      );
    }
    if (bytes.byteLength !== 32) {
      throw new Error(
        "provider_master_key_invalid_length"
      );
    }
    return bytes;
  }
  async getProviderCryptoKey() {
    if (!this._providerCryptoKeyPromise) {
      this._providerCryptoKeyPromise = crypto.subtle.importKey(
        "raw",
        this.getProviderMasterKeyBytes(),
        {
          name: "AES-GCM"
        },
        false,
        [
          "encrypt",
          "decrypt"
        ]
      );
    }
    return await this._providerCryptoKeyPromise;
  }
  providerConfigAad(customerId, providerName, versionId) {
    return new TextEncoder().encode(
      "once:provider-config:v1:" + String(customerId) + ":" + String(providerName) + ":" + String(versionId)
    );
  }
  async encryptProviderConfig(customerId, providerName, versionId, config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(
        "provider_config_invalid"
      );
    }
    const key = await this.getProviderCryptoKey();
    const iv = crypto.getRandomValues(
      new Uint8Array(12)
    );
    const plaintext = new TextEncoder().encode(
      JSON.stringify(config)
    );
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: this.providerConfigAad(
          customerId,
          providerName,
          versionId
        ),
        tagLength: 128
      },
      key,
      plaintext
    );
    return {
      encryptedConfig: this.providerBytesToBase64(
        new Uint8Array(
          encrypted
        )
      ),
      ivB64: this.providerBytesToBase64(
        iv
      ),
      keyVersion: 1
    };
  }
  async decryptProviderConfig(customerId, providerName, versionId, encryptedConfig, ivB64, keyVersion = 1) {
    if (Number(keyVersion) !== 1) {
      throw new Error(
        "provider_key_version_unsupported"
      );
    }
    const key = await this.getProviderCryptoKey();
    const iv = this.providerBase64ToBytes(
      ivB64
    );
    if (iv.byteLength !== 12) {
      throw new Error(
        "provider_config_iv_invalid"
      );
    }
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: this.providerConfigAad(
            customerId,
            providerName,
            versionId
          ),
          tagLength: 128
        },
        key,
        this.providerBase64ToBytes(
          encryptedConfig
        )
      );
    } catch {
      throw new Error(
        "provider_config_decryption_failed"
      );
    }
    let config;
    try {
      config = JSON.parse(
        new TextDecoder().decode(
          plaintext
        )
      );
    } catch {
      throw new Error(
        "provider_config_plaintext_invalid"
      );
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(
        "provider_config_plaintext_invalid"
      );
    }
    return config;
  }
  // HTTP_V1 PROVIDER CONFIG
  // ==============================================================
  getHttpV1Config() {
    const rawBase = String(
      this.env?.HTTP_V1_BASE_URL || ""
    ).trim();
    const token = String(
      this.env?.HTTP_V1_BEARER_TOKEN || ""
    ).trim();
    if (!rawBase || !token) {
      throw new Error(
        "http_v1_not_configured"
      );
    }
    let parsed;
    try {
      parsed = new URL(rawBase);
    } catch {
      throw new Error(
        "http_v1_base_url_invalid"
      );
    }
    if (parsed.protocol !== "https:") {
      throw new Error(
        "http_v1_base_url_must_be_https"
      );
    }
    return {
      baseUrl: rawBase.replace(
        /\/+$/,
        ""
      ),
      token
    };
  }
  // ==============================================================
  // HTTP_V1 PROVIDER TRUTH
  // ==============================================================
  async getHttpV1Provider(operationId, configOverride = null) {
    const config = configOverride || this.getHttpV1Config();
    const response = await fetch(
      config.baseUrl + "/truth/" + encodeURIComponent(
        operationId
      ),
      {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        method: "GET",
        headers: {
          "authorization": "Bearer " + config.token,
          "accept": "application/json"
        }
      }
    );
    if (!response.ok) {
      throw new Error(
        "http_v1_truth_http_" + response.status
      );
    }
    const data = await response.json();
    const sideEffects = onceValidateProviderObservation(data, operationId);
    if (sideEffects === 0) {
      return void 0;
    }
    return {
      operation_id: operationId,
      side_effects: sideEffects,
      executed_at: data.first_executed_at || data.last_executed_at || data.executed_at || null,
      first_executed_at: data.first_executed_at || data.executed_at || null,
      last_executed_at: data.last_executed_at || data.executed_at || null
    };
  }
  // ==============================================================
  // HTTP_V1 PROVIDER EXECUTE
  // ==============================================================
  async executeHttpV1Provider(operationId, action = {}, configOverride = null) {
    const config = configOverride || this.getHttpV1Config();
    const response = await fetch(
      config.baseUrl + "/execute",
      {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        method: "POST",
        headers: {
          "authorization": "Bearer " + config.token,
          "content-type": "application/json",
          "accept": "application/json"
        },
        body: JSON.stringify({
          operation_id: operationId,
          action
        })
      }
    );
    if (!response.ok) {
      let failureData = null;
      try {
        failureData = await response.json();
      } catch {
        failureData = null;
      }
      const error = new Error(
        "http_v1_execute_http_" + response.status
      );
      error.provider_status = response.status;
      if (failureData && failureData.provider_executed === false && failureData.side_effects === 0 && failureData.outcome === "rejected_before_effect") {
        error.once_failure_class = "FAILED_BEFORE_EFFECT";
        error.provider_outcome = "rejected_before_effect";
        error.provider_executed = false;
        error.side_effects = 0;
      }
      throw error;
    }
    const data = await response.json();
    const sideEffects = onceValidateProviderObservation(data, operationId);
    if (sideEffects !== 1) {
      throw new Error(
        "http_v1_execute_unconfirmed"
      );
    }
    return {
      operation_id: operationId,
      side_effects: sideEffects,
      executed_at: data.first_executed_at || data.last_executed_at || data.executed_at || null,
      first_executed_at: data.first_executed_at || data.executed_at || null,
      last_executed_at: data.last_executed_at || data.executed_at || null,
      http_response: data.http_response === void 0 ? null : data.http_response
    };
  }
  // ==============================================================
  // STRIPE_V1 EXTERNAL PROVIDER ? SANDBOX PROOF ONLY
  // ==============================================================
  //
  // Authoritative state is held by Stripe sandbox.
  // No Stripe Idempotency-Key is sent.
  // NEVER configure this adapter with a live Stripe key.
  //
  getStripeV1Config() {
    const secretKey = String(
      this.env?.STRIPE_V1_SECRET_KEY || ""
    ).trim();
    if (!secretKey) {
      throw new Error(
        "stripe_v1_not_configured"
      );
    }
    if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) {
      throw new Error(
        "stripe_v1_test_key_required"
      );
    }
    return {
      secretKey
    };
  }
  async getStripeV1OperationEmail(operationId) {
    const digest = await onceSha256Hex(
      "once:stripe:v1:" + String(operationId)
    );
    return "once-" + digest + "@example.invalid";
  }
  // ==============================================================
  // STRIPE_V1 PROVIDER TRUTH
  // ==============================================================
  async getStripeV1Provider(operationId) {
    const config = this.getStripeV1Config();
    const email = await this.getStripeV1OperationEmail(
      operationId
    );
    const url = new URL(
      "https://api.stripe.com/v1/customers"
    );
    url.searchParams.set(
      "email",
      email
    );
    url.searchParams.set(
      "limit",
      "100"
    );
    const response = await fetch(
      url.toString(),
      {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        method: "GET",
        headers: {
          "authorization": "Bearer " + config.secretKey,
          "accept": "application/json"
        }
      }
    );
    if (!response.ok) {
      throw new Error(
        "stripe_v1_truth_http_" + response.status
      );
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.data) || typeof data.has_more !== "boolean") {
      throw new Error("stripe_v1_truth_invalid");
    }
    if (data.has_more) {
      throw new Error(
        "stripe_v1_truth_too_many_matches"
      );
    }
    const customers = Array.isArray(data.data) ? data.data : [];
    const matches = customers.filter(
      (customer2) => customer2 && customer2.livemode === false && customer2.email === email && customer2.metadata?.once_operation_id === String(operationId) && customer2.metadata?.once_provider === "stripe_v1"
    );
    if (matches.length === 0) {
      return void 0;
    }
    if (matches.length > 1) {
      throw new Error(
        "stripe_v1_duplicate_effects_detected_" + matches.length
      );
    }
    const customer = matches[0];
    const executedAt = customer.created ? new Date(
      Number(
        customer.created
      ) * 1e3
    ).toISOString() : null;
    return {
      operation_id: operationId,
      side_effects: 1,
      executed_at: executedAt,
      first_executed_at: executedAt,
      last_executed_at: executedAt,
      stripe_customer_id: customer.id
    };
  }
  // ==============================================================
  // STRIPE_V1 PROVIDER EXECUTE
  // ==============================================================
  async executeStripeV1Provider(operationId, action = {}) {
    const config = this.getStripeV1Config();
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error(
        "stripe_v1_action_invalid"
      );
    }
    if (String(
      action.type || ""
    ) !== "create_customer") {
      throw new Error(
        "stripe_v1_action_unsupported"
      );
    }
    const email = await this.getStripeV1OperationEmail(
      operationId
    );
    const form = new URLSearchParams();
    form.set(
      "email",
      email
    );
    form.set(
      "name",
      String(
        action.name || "Once Stripe External Proof"
      ).slice(
        0,
        200
      )
    );
    form.set(
      "description",
      "Once stripe_v1 external-provider sandbox proof"
    );
    form.set(
      "metadata[once_operation_id]",
      String(operationId)
    );
    form.set(
      "metadata[once_provider]",
      "stripe_v1"
    );
    form.set(
      "metadata[once_test]",
      "external_provider_proof"
    );
    const response = await fetch(
      "https://api.stripe.com/v1/customers",
      {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        method: "POST",
        headers: {
          "authorization": "Bearer " + config.secretKey,
          "content-type": "application/x-www-form-urlencoded",
          "accept": "application/json"
        },
        body: form.toString()
      }
    );
    if (!response.ok) {
      throw new Error(
        "stripe_v1_execute_http_" + response.status
      );
    }
    const customer = await response.json();
    if (!customer || !customer.id || customer.livemode !== false) {
      throw new Error(
        "stripe_v1_execute_unconfirmed"
      );
    }
    const executedAt = customer.created ? new Date(
      Number(
        customer.created
      ) * 1e3
    ).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
    if (action.fault === "commit_then_503") {
      throw new Error(
        "stripe_v1_injected_commit_then_503"
      );
    }
    return {
      operation_id: operationId,
      side_effects: 1,
      executed_at: executedAt,
      first_executed_at: executedAt,
      last_executed_at: executedAt,
      stripe_customer_id: customer.id
    };
  }
  // ==============================================================
  // REGISTERED HTTP_V1 IMMUTABLE PROVIDER VERSION
  // ==============================================================
  async getRegisteredHttpV1Config(providerIdentity) {
    const identity = String(
      providerIdentity || ""
    ).trim().toLowerCase();
    const prefix = "registered_http_v1:";
    if (!identity.startsWith(
      prefix
    )) {
      throw new Error(
        "registered_provider_identity_invalid"
      );
    }
    const versionId = identity.substring(
      prefix.length
    );
    if (!/^pv_[a-f0-9]{32}$/.test(
      versionId
    )) {
      throw new Error(
        "registered_provider_version_invalid"
      );
    }
    const row = [
      ...this.ctx.storage.sql.exec(
        `
                        SELECT
                                version_id,
                                customer_id,
                                provider_name,
                                provider_type,
                                encrypted_config,
                                iv_b64,
                                key_version
                        FROM provider_versions
                        WHERE version_id = ?
                        LIMIT 1
                        `,
        versionId
      )
    ][0];
    if (!row) {
      throw new Error(
        "registered_provider_version_not_found"
      );
    }
    if (String(
      row.provider_type
    ).toLowerCase() !== "http_v1") {
      throw new Error(
        "registered_provider_type_invalid"
      );
    }
    const config = await this.decryptProviderConfig(
      row.customer_id,
      row.provider_name,
      row.version_id,
      row.encrypted_config,
      row.iv_b64,
      row.key_version
    );
    const rawBase = String(
      config.baseUrl || ""
    ).trim();
    const token = String(
      config.token || ""
    ).trim();
    const allowedUrls = Array.isArray(
      config.allowedUrls
    ) ? config.allowedUrls.map(
      (value) => String(
        value || ""
      ).trim()
    ).filter(Boolean) : [];
    const responseReplay = config.responseReplay === void 0 ? null : String(
      config.responseReplay || ""
    ).trim().toLowerCase();
    if (responseReplay !== null && responseReplay !== "required") {
      throw new Error(
        "registered_provider_response_replay_invalid"
      );
    }
    if (!rawBase || !token) {
      throw new Error(
        "registered_provider_config_invalid"
      );
    }
    let parsed;
    try {
      parsed = new URL(
        rawBase
      );
    } catch {
      throw new Error(
        "registered_provider_base_url_invalid"
      );
    }
    if (parsed.protocol !== "https:") {
      throw new Error(
        "registered_provider_base_url_must_be_https"
      );
    }
    return {
      baseUrl: rawBase.replace(
        /\/+$/,
        ""
      ),
      token,
      allowedUrls,
      responseReplay
    };
  }
  async getRegisteredHttpV1Provider(providerIdentity, operationId) {
    const config = await this.getRegisteredHttpV1Config(
      providerIdentity
    );
    return await this.getHttpV1Provider(
      operationId,
      config
    );
  }
  async executeRegisteredHttpV1Provider(providerIdentity, operationId, action = {}) {
    const config = await this.getRegisteredHttpV1Config(
      providerIdentity
    );
    return await this.executeHttpV1Provider(
      operationId,
      action,
      config
    );
  }
  // CORE PROVIDER IDENTITY
  // ==============================================================
  getOperationProvider(operationId) {
    const row = [
      ...this.ctx.storage.sql.exec(
        `
                        SELECT provider
                        FROM operations
                        WHERE operation_id = ?
                        LIMIT 1
                        `,
        operationId
      )
    ][0];
    return String(
      row?.provider || "blind_test"
    ).trim().toLowerCase();
  }
  // ==============================================================
  // PROVIDER ADAPTER REGISTRY - TRUTH
  // ==============================================================
  async getProvider(providerName, operationId) {
    const normalizedProviderName = String(providerName).trim().toLowerCase();
    if (normalizedProviderName.startsWith(
      "registered_http_v1:"
    )) {
      return await this.getRegisteredHttpV1Provider(
        normalizedProviderName,
        operationId
      );
    }
    switch (normalizedProviderName) {
      case "blind_test":
        return await this.getBlindTestProvider(
          operationId
        );
      case "http_v1":
        return await this.getHttpV1Provider(
          operationId
        );
      case "stripe_v1":
        return await this.getStripeV1Provider(
          operationId
        );
      default:
        throw new Error(
          "unsupported_provider_" + String(providerName)
        );
    }
  }
  // ==============================================================
  // PROVIDER ADAPTER REGISTRY - EXECUTE
  // ==============================================================
  async executeProvider(providerName, operationId, action = {}) {
    const normalizedProviderName = String(providerName).trim().toLowerCase();
    if (normalizedProviderName.startsWith(
      "registered_http_v1:"
    )) {
      return await this.executeRegisteredHttpV1Provider(
        normalizedProviderName,
        operationId,
        action
      );
    }
    switch (normalizedProviderName) {
      case "blind_test":
        return await this.executeBlindTestProvider(
          operationId
        );
      case "http_v1":
        return await this.executeHttpV1Provider(
          operationId,
          action
        );
      case "stripe_v1":
        return await this.executeStripeV1Provider(
          operationId,
          action
        );
      default:
        throw new Error(
          "unsupported_provider_" + String(providerName)
        );
    }
  }
  // REQUEST HANDLER
  // ==========================================================
  // ==========================================================
  // ONCE UNKNOWN RECONCILIATION V1
  //
  // SAFETY INVARIANT:
  //
  //   Background reconciliation reads provider truth only.
  //   It never invokes a provider execution adapter.
  //
  // Positive provider truth may move UNKNOWN -> CONFIRMED.
  // Negative or unavailable truth leaves UNKNOWN unchanged.
  // ==========================================================
  reconciliationDelayMs(checks) {
    const delays = [
      5e3,
      5e3,
      5e3,
      1e4,
      15e3,
      3e4,
      6e4,
      12e4,
      3e5,
      6e5,
      9e5
    ];
    const index = Math.min(
      Math.max(
        0,
        Math.trunc(
          Number(checks) || 0
        )
      ),
      delays.length - 1
    );
    return delays[index];
  }
  async enqueueUnknownReconciliation(operationId, delayMs = 5e3) {
    try {
      const operation = this.getOperation(
        operationId
      );
      if (!operation || operation.state !== "UNKNOWN") {
        return false;
      }
      const nowMs = Date.now();
      const nowIso = new Date(
        nowMs
      ).toISOString();
      const desiredAt = nowMs + Math.max(
        250,
        Number(delayMs) || 5e3
      );
      const existing = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          checks,
                                          next_check_at,
                                          exhausted_at
                                  FROM unknown_reconciliation
                                  WHERE operation_id = ?
                                  LIMIT 1
                                  `,
          operationId
        )
      ][0];
      if (existing) {
        if (existing.exhausted_at) {
          this.ctx.storage.sql.exec(
            `
                                          UPDATE unknown_reconciliation
                                          SET
                                                  checks = 0,
                                                  next_check_at = ?,
                                                  updated_at = ?,
                                                  exhausted_at = NULL
                                          WHERE operation_id = ?
                                          `,
            desiredAt,
            nowIso,
            operationId
          );
        } else {
          const existingAt = Number(
            existing.next_check_at || 0
          );
          const nextAt2 = existingAt > 0 ? Math.min(
            existingAt,
            desiredAt
          ) : desiredAt;
          this.ctx.storage.sql.exec(
            `
                                          UPDATE unknown_reconciliation
                                          SET
                                                  next_check_at = ?,
                                                  updated_at = ?
                                          WHERE operation_id = ?
                                          `,
            nextAt2,
            nowIso,
            operationId
          );
        }
      } else {
        this.ctx.storage.sql.exec(
          `
                                  INSERT INTO unknown_reconciliation (
                                          operation_id,
                                          checks,
                                          next_check_at,
                                          created_at,
                                          updated_at
                                  )
                                  VALUES (?, 0, ?, ?, ?)
                                  `,
          operationId,
          desiredAt,
          nowIso,
          nowIso
        );
      }
      const earliest = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          MIN(next_check_at) AS next_check_at
                                  FROM unknown_reconciliation
                                  WHERE exhausted_at IS NULL
                                  `
        )
      ][0];
      if (earliest?.next_check_at === null || earliest?.next_check_at === void 0) {
        return true;
      }
      const nextAt = Number(
        earliest.next_check_at
      );
      if (Number.isFinite(nextAt)) {
        const currentAlarm = await this.ctx.storage.getAlarm();
        const scheduledAt = Math.max(
          Date.now() + 100,
          nextAt
        );
        if (currentAlarm === null || scheduledAt < currentAlarm) {
          await this.ctx.storage.setAlarm(
            scheduledAt
          );
        }
      }
      return true;
    } catch {
      await this.onceLog(
        "once.reconcile.schedule_error",
        {
          operationId,
          status: 500,
          result: "schedule_error"
        }
      );
      return false;
    }
  }
  async ensureUnknownReconciliationAlarm() {
    try {
      const earliest = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          MIN(next_check_at) AS next_check_at
                                  FROM unknown_reconciliation
                                  WHERE exhausted_at IS NULL
                                  `
        )
      ][0];
      if (earliest?.next_check_at === null || earliest?.next_check_at === void 0) {
        return;
      }
      const nextAt = Number(
        earliest.next_check_at
      );
      if (!Number.isFinite(nextAt)) {
        return;
      }
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm !== null) {
        return;
      }
      await this.ctx.storage.setAlarm(
        Math.max(
          Date.now() + 100,
          nextAt
        )
      );
    } catch {
    }
  }
  async alarm() {
    try {
      const nowMs = Date.now();
      const due = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          q.operation_id,
                                          q.checks,
                                          o.provider,
                                          o.state,
                                          o.attempts
                                  FROM unknown_reconciliation q
                                  LEFT JOIN operations o
                                          ON o.operation_id =
                                             q.operation_id
                                  WHERE
                                          q.exhausted_at IS NULL
                                          AND q.next_check_at <= ?
                                  ORDER BY q.next_check_at ASC
                                  LIMIT 25
                                  `,
          nowMs
        )
      ];
      for (const row of due) {
        const operationId = row.operation_id;
        const providerName = String(
          row.provider || "blind_test"
        ).trim().toLowerCase();
        if (row.state !== "UNKNOWN") {
          this.ctx.storage.sql.exec(
            `
                                          DELETE FROM unknown_reconciliation
                                          WHERE operation_id = ?
                                          `,
            operationId
          );
          continue;
        }
        try {
          const providerTruth = await this.getProvider(
            providerName,
            operationId
          );
          const current = this.getOperation(
            operationId
          );
          if (!current || current.state !== "UNKNOWN") {
            this.ctx.storage.sql.exec(
              `
                                                  DELETE FROM unknown_reconciliation
                                                  WHERE operation_id = ?
                                                  `,
              operationId
            );
            continue;
          }
          if (providerTruth) {
            if (this.isHttpResponseReplayRequired(
              operationId
            ) && !this.getHttpResponseReplay(
              operationId
            )) {
              const quarantinedAt = (/* @__PURE__ */ new Date()).toISOString();
              this.ctx.storage.sql.exec(
                `
                                                           UPDATE unknown_reconciliation
                                                           SET
                                                                   checks =
                                                                       checks + 1,
                                                                   updated_at = ?,
                                                                   exhausted_at = ?
                                                           WHERE operation_id = ?
                                                           `,
                quarantinedAt,
                quarantinedAt,
                operationId
              );
              await this.onceLog(
                "once.reconcile.replay_missing_quarantined",
                {
                  operationId,
                  provider: providerName,
                  state: "UNKNOWN",
                  attempts: row.attempts,
                  status: 409,
                  result: "replay_required_missing"
                }
              );
              continue;
            }
            this.ctx.storage.sql.exec(
              `
                                                  UPDATE operations
                                                  SET state = 'CONFIRMED'
                                                  WHERE
                                                          operation_id = ?
                                                          AND state = 'UNKNOWN'
                                                  `,
              operationId
            );
            this.ctx.storage.sql.exec(
              `
                                                  DELETE FROM unknown_reconciliation
                                                  WHERE operation_id = ?
                                                  `,
              operationId
            );
            const confirmed = this.getOperation(
              operationId
            );

            try {
              this.recordConfirmationReceipt(
                operationId,
                providerName,
                providerTruth,
                (new Date()).toISOString()
              );
            } catch {
            }

            await this.onceLog(
              "once.reconcile.confirmed",
              {
                operationId,
                provider: providerName,
                state: confirmed ? confirmed.state : "CONFIRMED",
                attempts: confirmed ? confirmed.attempts : row.attempts,
                status: 200,
                result: "provider_truth_confirmed"
              }
            );
            continue;
          }
          const nextChecks = Number(
            row.checks || 0
          ) + 1;
          if (nextChecks >= 24) {
            const exhaustedAt = (/* @__PURE__ */ new Date()).toISOString();
            this.ctx.storage.sql.exec(
              `
                                                  UPDATE unknown_reconciliation
                                                  SET
                                                          checks = ?,
                                                          updated_at = ?,
                                                          exhausted_at = ?
                                                  WHERE operation_id = ?
                                                  `,
              nextChecks,
              exhaustedAt,
              exhaustedAt,
              operationId
            );
            await this.onceLog(
              "once.reconcile.exhausted",
              {
                operationId,
                provider: providerName,
                state: "UNKNOWN",
                attempts: row.attempts,
                result: "provider_truth_absent_exhausted"
              }
            );
            continue;
          }
          const nextAt = Date.now() + this.reconciliationDelayMs(
            nextChecks
          );
          this.ctx.storage.sql.exec(
            `
                                          UPDATE unknown_reconciliation
                                          SET
                                                  checks = ?,
                                                  next_check_at = ?,
                                                  updated_at = ?
                                          WHERE operation_id = ?
                                          `,
            nextChecks,
            nextAt,
            (/* @__PURE__ */ new Date()).toISOString(),
            operationId
          );
          await this.onceLog(
            "once.reconcile.pending",
            {
              operationId,
              provider: providerName,
              state: "UNKNOWN",
              attempts: current.attempts,
              status: 200,
              result: "provider_truth_absent"
            }
          );
        } catch {
          const nextChecks = Number(
            row.checks || 0
          ) + 1;
          if (nextChecks >= 24) {
            const exhaustedAt = (/* @__PURE__ */ new Date()).toISOString();
            this.ctx.storage.sql.exec(
              `
                                                  UPDATE unknown_reconciliation
                                                  SET
                                                          checks = ?,
                                                          updated_at = ?,
                                                          exhausted_at = ?
                                                  WHERE operation_id = ?
                                                  `,
              nextChecks,
              exhaustedAt,
              exhaustedAt,
              operationId
            );
            await this.onceLog(
              "once.reconcile.exhausted",
              {
                operationId,
                provider: providerName,
                state: "UNKNOWN",
                attempts: row.attempts,
                result: "provider_truth_unavailable_exhausted"
              }
            );
            continue;
          }
          const nextAt = Date.now() + this.reconciliationDelayMs(
            nextChecks
          );
          this.ctx.storage.sql.exec(
            `
                                          UPDATE unknown_reconciliation
                                          SET
                                                  checks = ?,
                                                  next_check_at = ?,
                                                  updated_at = ?
                                          WHERE operation_id = ?
                                          `,
            nextChecks,
            nextAt,
            (/* @__PURE__ */ new Date()).toISOString(),
            operationId
          );
          await this.onceLog(
            "once.reconcile.provider_unavailable",
            {
              operationId,
              provider: providerName,
              state: "UNKNOWN",
              attempts: row.attempts,
              status: 503,
              result: "provider_truth_unavailable"
            }
          );
        }
      }
      this.ctx.storage.sql.exec(
        `
                          DELETE FROM unknown_reconciliation
                          WHERE operation_id NOT IN (
                                  SELECT operation_id
                                  FROM operations
                                  WHERE state = 'UNKNOWN'
                          )
                          `
      );
      const next = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          MIN(next_check_at) AS next_check_at
                                  FROM unknown_reconciliation
                                  WHERE exhausted_at IS NULL
                                  `
        )
      ][0];
      if (next?.next_check_at !== null && next?.next_check_at !== void 0) {
        const nextAt = Number(
          next.next_check_at
        );
        if (Number.isFinite(nextAt)) {
          await this.ctx.storage.setAlarm(
            Math.max(
              Date.now() + 100,
              nextAt
            )
          );
        }
      }
    } catch {
      try {
        await this.onceLog(
          "once.reconcile.alarm_error",
          {
            status: 500,
            result: "alarm_error"
          }
        );
        await this.ctx.storage.setAlarm(
          Date.now() + 6e4
        );
      } catch {
        throw new Error(
          "once_reconciliation_alarm_failed"
        );
      }
    }
  }
  async fetch(request) {
    await this.ensureUnknownReconciliationAlarm();
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/stripe/event") {
      let event;
      try {
        event = await request.json();
      } catch {
        return json(
          {
            error: "invalid_stripe_event_json"
          },
          400
        );
      }
      const eventId = String(
        event?.id || ""
      ).trim();
      const eventType = String(
        event?.type || ""
      ).trim();
      if (!eventId || !eventType) {
        return json(
          {
            error: "invalid_stripe_event"
          },
          400
        );
      }
      const existingEvent = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT event_id
                                  FROM stripe_events
                                  WHERE event_id = ?
                                  LIMIT 1
                                  `,
          eventId
        )
      ][0];
      if (existingEvent) {
        return json({
          received: true,
          duplicate: true,
          event_id: eventId,
          type: eventType
        });
      }
      const subscriptionEvents = /* @__PURE__ */ new Set([
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted"
      ]);
      let processed = false;
      let entitlement = null;
      if (subscriptionEvents.has(
        eventType
      )) {
        const subscription = event?.data?.object || {};
        const customerId = typeof subscription.customer === "string" ? subscription.customer : String(
          subscription?.customer?.id || ""
        );
        const subscriptionId = String(
          subscription.id || ""
        ).trim();
        const firstItem = subscription?.items?.data?.[0];
        const priceId = String(
          firstItem?.price?.id || ""
        ).trim();
        const pricePlanMap = {
          "price_1UGqPRAHX5spO4zqQcuRzi3S": "pro",
          "price_1UGqPWAHX5spO4zqWlFeMbwO": "startup",
          "price_1UGqPfAHX5spO4zqKaLaAINp": "scale"
        };
        const metadataPlan = String(
          subscription?.metadata?.plan || ""
        ).trim().toLowerCase();
        const plan = metadataPlan || pricePlanMap[priceId] || "unknown";
        const status = eventType === "customer.subscription.deleted" ? "canceled" : String(
          subscription?.status || "unknown"
        );
        let periodEnd = subscription?.current_period_end || firstItem?.current_period_end || null;
        if (periodEnd) {
          const n = Number(periodEnd);
          periodEnd = Number.isFinite(n) ? new Date(
            n * 1e3
          ).toISOString() : null;
        }
        if (!customerId || !subscriptionId) {
          return json(
            {
              error: "stripe_subscription_identity_missing",
              event_id: eventId
            },
            400
          );
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        this.ctx.storage.sql.exec(
          `
                                  INSERT INTO stripe_entitlements (
                                          customer_id,
                                          subscription_id,
                                          plan,
                                          status,
                                          price_id,
                                          current_period_end,
                                          updated_at
                                  )
                                  VALUES (?, ?, ?, ?, ?, ?, ?)

                                  ON CONFLICT(customer_id)
                                  DO UPDATE SET
                                          subscription_id =
                                              excluded.subscription_id,

                                          plan =
                                              excluded.plan,

                                          status =
                                              excluded.status,

                                          price_id =
                                              excluded.price_id,

                                          current_period_end =
                                              excluded.current_period_end,

                                          updated_at =
                                              excluded.updated_at
                                  `,
          customerId,
          subscriptionId,
          plan,
          status,
          priceId || null,
          periodEnd,
          now
        );
        processed = true;
        entitlement = {
          customer_id: customerId,
          subscription_id: subscriptionId,
          plan,
          status,
          price_id: priceId || null,
          current_period_end: periodEnd
        };
      }
      const processedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.ctx.storage.sql.exec(
        `
                          INSERT INTO stripe_events (
                                  event_id,
                                  type,
                                  processed_at
                          )
                          VALUES (?, ?, ?)
                          `,
        eventId,
        eventType,
        processedAt
      );
      return json({
        received: true,
        duplicate: false,
        processed,
        event_id: eventId,
        type: eventType,
        entitlement
      });
    }
    if (request.method === "GET" && url.pathname.startsWith(
      "/stripe/entitlement/"
    )) {
      const customerId = decodeURIComponent(
        url.pathname.substring(
          "/stripe/entitlement/".length
        )
      );
      const entitlement = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          customer_id,
                                          subscription_id,
                                          plan,
                                          status,
                                          price_id,
                                          current_period_end,
                                          updated_at
                                  FROM stripe_entitlements
                                  WHERE customer_id = ?
                                  LIMIT 1
                                  `,
          customerId
        )
      ][0];
      if (!entitlement) {
        return json(
          {
            found: false,
            customer_id: customerId
          },
          404
        );
      }
      return json({
        found: true,
        ...entitlement
      });
    }
    if (request.method === "POST" && url.pathname === "/admin/api-keys") {
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
      const customerId = String(
        body.customer_id || ""
      ).trim();
      if (!customerId) {
        return json(
          {
            error: "customer_id_required"
          },
          400
        );
      }
      const entitlement = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          customer_id,
                                          plan,
                                          status,
                                          current_period_end
                                  FROM stripe_entitlements
                                  WHERE customer_id = ?
                                  LIMIT 1
                                  `,
          customerId
        )
      ][0];
      if (!entitlement) {
        return json(
          {
            error: "entitlement_not_found"
          },
          404
        );
      }
      const allowedStatuses = /* @__PURE__ */ new Set([
        "active",
        "trialing"
      ]);
      if (!allowedStatuses.has(
        entitlement.status
      )) {
        return json(
          {
            error: "subscription_not_active",
            status: entitlement.status
          },
          403
        );
      }
      const plan = String(
        entitlement.plan || ""
      ).toLowerCase();
      if (!ONCE_PLAN_LIMITS[plan]) {
        return json(
          {
            error: "unknown_plan",
            plan
          },
          400
        );
      }
      const token = onceRandomHex(32);
      const rawKey = "once_test_" + token;
      const keyHash = await onceSha256Hex(
        rawKey
      );
      const keyId = "key_" + onceRandomHex(12);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      this.ctx.storage.sql.exec(
        `
                          INSERT INTO api_keys (
                                  key_id,
                                  key_hash,
                                  customer_id,
                                  created_at,
                                  revoked_at
                          )
                          VALUES (?, ?, ?, ?, NULL)
                          `,
        keyId,
        keyHash,
        customerId,
        now
      );
      return json({
        created: true,
        key_id: keyId,
        api_key: rawKey,
        customer_id: customerId,
        plan,
        monthly_limit: ONCE_PLAN_LIMITS[plan],
        warning: "This API key is returned once. Store it securely."
      });
    }
    if (request.method === "POST" && url.pathname === "/admin/api-keys/revoke") {
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
      const keyId = String(
        body.key_id || ""
      ).trim();
      if (!keyId) {
        return json(
          {
            error: "key_id_required"
          },
          400
        );
      }
      const existing = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          key_id,
                                          customer_id,
                                          revoked_at
                                  FROM api_keys
                                  WHERE key_id = ?
                                  LIMIT 1
                                  `,
          keyId
        )
      ][0];
      if (!existing) {
        return json(
          {
            error: "api_key_not_found"
          },
          404
        );
      }
      if (existing.revoked_at) {
        return json({
          revoked: true,
          already_revoked: true,
          key_id: existing.key_id,
          customer_id: existing.customer_id,
          revoked_at: existing.revoked_at
        });
      }
      const revokedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.ctx.storage.sql.exec(
        `
                          UPDATE api_keys
                          SET revoked_at = ?
                          WHERE key_id = ?
                          `,
        revokedAt,
        keyId
      );
      return json({
        revoked: true,
        already_revoked: false,
        key_id: existing.key_id,
        customer_id: existing.customer_id,
        revoked_at: revokedAt
      });
    }
    if (request.method === "GET" && url.pathname.startsWith(
      "/v1/truth/"
    )) {
      const authorization = request.headers.get(
        "authorization"
      ) || "";
      if (!authorization.startsWith(
        "Bearer "
      )) {
        return json(
          {
            error: "api_key_required"
          },
          401
        );
      }
      const rawKey = authorization.substring(
        "Bearer ".length
      ).trim();
      if (!rawKey) {
        return json(
          {
            error: "api_key_required"
          },
          401
        );
      }
      const keyHash = await onceSha256Hex(
        rawKey
      );
      const keyRecord = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          key_id,
                                          customer_id
                                  FROM api_keys
                                  WHERE
                                          key_hash = ?
                                          AND revoked_at IS NULL
                                  LIMIT 1
                                  `,
          keyHash
        )
      ][0];
      if (!keyRecord) {
        return json(
          {
            error: "invalid_api_key"
          },
          401
        );
      }
      const customerOperationId = decodeURIComponent(
        url.pathname.substring(
          "/v1/truth/".length
        )
      );
      if (!customerOperationId) {
        return json(
          {
            error: "operation_id_required"
          },
          400
        );
      }
      const scopedOperationId = await onceTenantScopedOperationId(
        keyRecord.customer_id,
        customerOperationId
      );
      const truthResponse = await this.fetch(
        new Request(
          "https://q18.internal/truth/" + encodeURIComponent(
            scopedOperationId
          ),
          {
            method: "GET"
          }
        )
      );
      const truthText = await truthResponse.text();
      let customerTruthBody = truthText;
      try {
        const parsed = JSON.parse(
          truthText
        );
        if (parsed && typeof parsed === "object") {
          parsed.operation_id = customerOperationId;
          customerTruthBody = JSON.stringify(
            parsed
          );
        }
      } catch {
      }
      const truthHeaders = new Headers(
        truthResponse.headers
      );
      truthHeaders.delete(
        "content-length"
      );
      return new Response(
        customerTruthBody,
        {
          status: truthResponse.status,
          statusText: truthResponse.statusText,
          headers: truthHeaders
        }
      );
    }
    if (request.method === "GET" && url.pathname.startsWith(
      "/v1/providers/"
    )) {
      const authorization = request.headers.get(
        "authorization"
      ) || "";
      if (!authorization.startsWith(
        "Bearer "
      )) {
        return json(
          {
            error: "api_key_required"
          },
          401
        );
      }
      const rawKey = authorization.substring(
        "Bearer ".length
      ).trim();
      if (!rawKey) {
        return json(
          {
            error: "api_key_required"
          },
          401
        );
      }
      const keyHash = await onceSha256Hex(
        rawKey
      );
      const keyRecord = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          key_id,
                                          customer_id
                                  FROM api_keys
                                  WHERE
                                          key_hash = ?
                                          AND revoked_at IS NULL
                                  LIMIT 1
                                  `,
          keyHash
        )
      ][0];
      if (!keyRecord) {
        return json(
          {
            error: "invalid_api_key"
          },
          401
        );
      }
      const providerName = decodeURIComponent(
        url.pathname.substring(
          "/v1/providers/".length
        )
      ).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(
        providerName
      )) {
        return json(
          {
            error: "invalid_provider_name"
          },
          400
        );
      }
      const alias = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          current_version_id,
                                          created_at,
                                          updated_at,
                                          disabled_at
                                  FROM provider_aliases
                                  WHERE
                                          customer_id = ?
                                          AND provider_name = ?
                                  LIMIT 1
                                  `,
          keyRecord.customer_id,
          providerName
        )
      ][0];
      if (!alias) {
        return json(
          {
            error: "provider_not_found"
          },
          404
        );
      }
      const versionRows = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          version_id,
                                          provider_type,
                                          created_at
                                  FROM provider_versions
                                  WHERE
                                          customer_id = ?
                                          AND provider_name = ?
                                  ORDER BY created_at ASC
                                  `,
          keyRecord.customer_id,
          providerName
        )
      ];
      const versions = versionRows.map(
        (row) => ({
          version_id: row.version_id,
          type: row.provider_type,
          created_at: row.created_at,
          current: row.version_id === alias.current_version_id
        })
      );
      return json({
        name: providerName,
        current_version_id: alias.current_version_id,
        disabled: Boolean(
          alias.disabled_at
        ),
        created_at: alias.created_at,
        updated_at: alias.updated_at,
        versions
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/providers") {
      const authorization = request.headers.get(
        "authorization"
      ) || "";
      if (!authorization.startsWith(
        "Bearer "
      )) {
        return json(
          {
            error: "api_key_required"
          },
          401
        );
      }
      const rawKey = authorization.substring(
        "Bearer ".length
      ).trim();
      if (!rawKey) {
        return json(
          {
            error: "api_key_required"
          },
          401
        );
      }
      const keyHash = await onceSha256Hex(
        rawKey
      );
      const keyRecord = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          key_id,
                                          customer_id
                                  FROM api_keys
                                  WHERE
                                          key_hash = ?
                                          AND revoked_at IS NULL
                                  LIMIT 1
                                  `,
          keyHash
        )
      ][0];
      if (!keyRecord) {
        return json(
          {
            error: "invalid_api_key"
          },
          401
        );
      }
      const entitlement = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          plan,
                                          status,
                                          current_period_end
                                  FROM stripe_entitlements
                                  WHERE customer_id = ?
                                  LIMIT 1
                                  `,
          keyRecord.customer_id
        )
      ][0];
      if (!entitlement) {
        return json(
          {
            error: "entitlement_not_found"
          },
          403
        );
      }
      const allowedStatuses = /* @__PURE__ */ new Set([
        "active",
        "trialing"
      ]);
      if (!allowedStatuses.has(
        entitlement.status
      )) {
        return json(
          {
            error: "subscription_not_active",
            status: entitlement.status
          },
          403
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
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(
          {
            error: "invalid_provider_body"
          },
          400
        );
      }
      const providerName = String(
        body.name || ""
      ).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(
        providerName
      )) {
        return json(
          {
            error: "invalid_provider_name",
            message: "name must be 1-63 lowercase letters, numbers, dots, underscores or hyphens"
          },
          400
        );
      }
      const reservedNames = /* @__PURE__ */ new Set([
        "blind_test",
        "http_v1",
        "stripe_v1"
      ]);
      if (reservedNames.has(
        providerName
      )) {
        return json(
          {
            error: "reserved_provider_name"
          },
          409
        );
      }
      const providerType = String(
        body.type || "http_v1"
      ).trim().toLowerCase();
      if (providerType !== "http_v1") {
        return json(
          {
            error: "unsupported_provider_type",
            allowed: [
              "http_v1"
            ]
          },
          400
        );
      }
      let responseReplay = null;
      if (body.response_replay !== void 0) {
        if (typeof body.response_replay !== "string") {
          return json(
            {
              error: "invalid_response_replay",
              allowed: [
                "required"
              ],
              message: "response_replay must be omitted for legacy behavior or set to required"
            },
            400
          );
        }
        responseReplay = body.response_replay.trim().toLowerCase();
        if (responseReplay !== "required") {
          return json(
            {
              error: "unsupported_response_replay",
              allowed: [
                "required"
              ],
              message: "omit response_replay for legacy behavior or set it to required"
            },
            400
          );
        }
      }
      const rawBase = String(
        body.base_url || ""
      ).trim();
      const token = String(
        body.token || ""
      ).trim();
      if (!rawBase) {
        return json(
          {
            error: "base_url_required"
          },
          400
        );
      }
      if (!token) {
        return json(
          {
            error: "provider_token_required"
          },
          400
        );
      }
      if (rawBase.length > 2048) {
        return json(
          {
            error: "base_url_too_long"
          },
          400
        );
      }
      if (token.length > 4096) {
        return json(
          {
            error: "provider_token_too_long"
          },
          400
        );
      }
      let parsedBase;
      try {
        parsedBase = new URL(
          rawBase
        );
      } catch {
        return json(
          {
            error: "provider_base_url_invalid"
          },
          400
        );
      }
      if (parsedBase.protocol !== "https:") {
        return json(
          {
            error: "provider_base_url_must_be_https"
          },
          400
        );
      }
      if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
        return json(
          {
            error: "provider_base_url_invalid_components"
          },
          400
        );
      }
      const hostname = parsedBase.hostname.toLowerCase();
      const blockedHostnames = /* @__PURE__ */ new Set([
        "localhost",
        "localhost.localdomain"
      ]);
      const blockedSuffixes = [
        ".localhost",
        ".local",
        ".internal"
      ];
      if (blockedHostnames.has(
        hostname
      ) || blockedSuffixes.some(
        (suffix) => hostname.endsWith(
          suffix
        )
      )) {
        return json(
          {
            error: "provider_host_not_allowed"
          },
          400
        );
      }
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(
        hostname
      ) || hostname.includes(":")) {
        return json(
          {
            error: "provider_ip_literal_not_allowed"
          },
          400
        );
      }
      const baseUrl = parsedBase.toString().replace(
        /\/+$/,
        ""
      );
      const rawAllowedUrls = body.allowed_urls === void 0 ? [] : body.allowed_urls;
      if (!Array.isArray(rawAllowedUrls)) {
        return json(
          {
            error: "allowed_urls_must_be_array"
          },
          400
        );
      }
      if (rawAllowedUrls.length > 32) {
        return json(
          {
            error: "allowed_urls_too_many",
            max: 32
          },
          400
        );
      }
      const allowedUrls = [];
      const seenAllowedUrls = /* @__PURE__ */ new Set();
      for (const rawAllowedUrl of rawAllowedUrls) {
        const candidate = String(
          rawAllowedUrl || ""
        ).trim();
        if (!candidate || candidate.length > 2048) {
          return json(
            {
              error: "allowed_url_invalid"
            },
            400
          );
        }
        let parsedAllowedUrl;
        try {
          parsedAllowedUrl = new URL(
            candidate
          );
        } catch {
          return json(
            {
              error: "allowed_url_invalid"
            },
            400
          );
        }
        if (parsedAllowedUrl.protocol !== "https:") {
          return json(
            {
              error: "allowed_url_must_be_https"
            },
            400
          );
        }
        if (parsedAllowedUrl.username || parsedAllowedUrl.password || parsedAllowedUrl.hash) {
          return json(
            {
              error: "allowed_url_invalid_components"
            },
            400
          );
        }
        const allowedHostname = parsedAllowedUrl.hostname.toLowerCase();
        const blockedAllowedHostnames = /* @__PURE__ */ new Set([
          "localhost",
          "localhost.localdomain"
        ]);
        const blockedAllowedSuffixes = [
          ".localhost",
          ".local",
          ".internal"
        ];
        if (blockedAllowedHostnames.has(
          allowedHostname
        ) || blockedAllowedSuffixes.some(
          (suffix) => allowedHostname.endsWith(
            suffix
          )
        )) {
          return json(
            {
              error: "allowed_url_host_not_allowed"
            },
            400
          );
        }
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(
          allowedHostname
        ) || allowedHostname.includes(":")) {
          return json(
            {
              error: "allowed_url_ip_literal_not_allowed"
            },
            400
          );
        }
        parsedAllowedUrl.searchParams.sort();
        const canonicalAllowedUrl = parsedAllowedUrl.toString();
        if (!seenAllowedUrls.has(
          canonicalAllowedUrl
        )) {
          seenAllowedUrls.add(
            canonicalAllowedUrl
          );
          allowedUrls.push(
            canonicalAllowedUrl
          );
        }
      }
      const versionId = "pv_" + crypto.randomUUID().replaceAll(
        "-",
        ""
      );
      const encrypted = await this.encryptProviderConfig(
        keyRecord.customer_id,
        providerName,
        versionId,
        {
          baseUrl,
          token,
          allowedUrls,
          ...responseReplay === "required" ? {
            responseReplay
          } : {}
        }
      );
      const verified = await this.decryptProviderConfig(
        keyRecord.customer_id,
        providerName,
        versionId,
        encrypted.encryptedConfig,
        encrypted.ivB64,
        encrypted.keyVersion
      );
      if (verified.baseUrl !== baseUrl || verified.token !== token || (verified.responseReplay || null) !== responseReplay || JSON.stringify(
        verified.allowedUrls || []
      ) !== JSON.stringify(
        allowedUrls
      )) {
        return json(
          {
            error: "provider_crypto_verification_failed"
          },
          500
        );
      }
      const existingAlias = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          current_version_id,
                                          disabled_at
                                  FROM provider_aliases
                                  WHERE
                                          customer_id = ?
                                          AND provider_name = ?
                                  LIMIT 1
                                  `,
          keyRecord.customer_id,
          providerName
        )
      ][0];
      const now = (/* @__PURE__ */ new Date()).toISOString();
      this.ctx.storage.sql.exec(
        `
                          INSERT INTO provider_versions (
                                  version_id,
                                  customer_id,
                                  provider_name,
                                  provider_type,
                                  encrypted_config,
                                  iv_b64,
                                  key_version,
                                  created_at
                          )
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                          `,
        versionId,
        keyRecord.customer_id,
        providerName,
        providerType,
        encrypted.encryptedConfig,
        encrypted.ivB64,
        encrypted.keyVersion,
        now
      );
      this.ctx.storage.sql.exec(
        `
                          INSERT INTO provider_aliases (
                                  customer_id,
                                  provider_name,
                                  current_version_id,
                                  created_at,
                                  updated_at,
                                  disabled_at
                          )
                          VALUES (?, ?, ?, ?, ?, NULL)

                          ON CONFLICT(
                                  customer_id,
                                  provider_name
                          )
                          DO UPDATE SET
                                  current_version_id =
                                      excluded.current_version_id,

                                  updated_at =
                                      excluded.updated_at,

                                  disabled_at =
                                      NULL
                          `,
        keyRecord.customer_id,
        providerName,
        versionId,
        now,
        now
      );
      return json(
        {
          created: !existingAlias,
          rotated: Boolean(
            existingAlias
          ),
          name: providerName,
          type: providerType,
          version_id: versionId,
          base_url: baseUrl,
          allowed_urls: allowedUrls,
          response_replay: responseReplay,
          credentials: "stored_encrypted"
        },
        existingAlias ? 200 : 201
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/execute") {
      const authorization = request.headers.get(
        "authorization"
      ) || "";
      if (!authorization.startsWith(
        "Bearer "
      )) {
        return json(
          {
            error: "api_key_required"
          },
          401
        );
      }
      const rawKey = authorization.substring(
        "Bearer ".length
      ).trim();
      if (!rawKey) {
        return json(
          {
            error: "api_key_required"
          },
          401
        );
      }
      const keyHash = await onceSha256Hex(
        rawKey
      );
      const keyRecord = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          key_id,
                                          customer_id
                                  FROM api_keys
                                  WHERE
                                          key_hash = ?
                                          AND revoked_at IS NULL
                                  LIMIT 1
                                  `,
          keyHash
        )
      ][0];
      if (!keyRecord) {
        return json(
          {
            error: "invalid_api_key"
          },
          401
        );
      }
      const entitlement = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          plan,
                                          status,
                                          current_period_end
                                  FROM stripe_entitlements
                                  WHERE customer_id = ?
                                  LIMIT 1
                                  `,
          keyRecord.customer_id
        )
      ][0];
      if (!entitlement) {
        return json(
          {
            error: "entitlement_not_found"
          },
          403
        );
      }
      const allowedStatuses = /* @__PURE__ */ new Set([
        "active",
        "trialing"
      ]);
      if (!allowedStatuses.has(
        entitlement.status
      )) {
        return json(
          {
            error: "subscription_not_active",
            status: entitlement.status
          },
          403
        );
      }
      const plan = String(
        entitlement.plan || ""
      ).toLowerCase();
      const monthlyLimit = ONCE_PLAN_LIMITS[plan];
      if (!monthlyLimit) {
        return json(
          {
            error: "unknown_plan",
            plan
          },
          403
        );
      }
      const ONCE_EXECUTE_REQUESTS_PER_MINUTE = 120;
      const rateNowMs = Date.now();
      const rateWindowKey = Math.floor(
        rateNowMs / 6e4
      );
      const rateWindowEndsAt = (rateWindowKey + 1) * 6e4;
      const rateRetryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (rateWindowEndsAt - rateNowMs) / 1e3
        )
      );
      const rateUpdatedAt = new Date(
        rateNowMs
      ).toISOString();
      this.ctx.storage.sql.exec(
        `
                          DELETE FROM execute_rate_limits
                          WHERE
                                  customer_id = ?
                                  AND window_key < ?
                          `,
        keyRecord.customer_id,
        rateWindowKey - 1
      );
      this.ctx.storage.sql.exec(
        `
                          INSERT INTO execute_rate_limits (
                                  customer_id,
                                  window_key,
                                  request_count,
                                  updated_at
                          )
                          VALUES (?, ?, 1, ?)

                          ON CONFLICT (
                                  customer_id,
                                  window_key
                          )
                          DO UPDATE SET
                                  request_count =
                                      request_count + 1,

                                  updated_at =
                                      excluded.updated_at
                          `,
        keyRecord.customer_id,
        rateWindowKey,
        rateUpdatedAt
      );
      const rateRecord = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          request_count
                                  FROM execute_rate_limits
                                  WHERE
                                          customer_id = ?
                                          AND window_key = ?
                                  LIMIT 1
                                  `,
          keyRecord.customer_id,
          rateWindowKey
        )
      ][0];
      const executeRequestsThisWindow = Number(
        rateRecord?.request_count || 0
      );
      if (executeRequestsThisWindow > ONCE_EXECUTE_REQUESTS_PER_MINUTE) {
        await this.onceLog(
          "once.execute.rate_limited",
          {
            status: 429,
            result: "rate_limit_exceeded"
          }
        );
        return new Response(
          JSON.stringify(
            {
              error: "rate_limit_exceeded",
              limit: ONCE_EXECUTE_REQUESTS_PER_MINUTE,
              window_seconds: 60,
              retry_after_seconds: rateRetryAfterSeconds
            }
          ),
          {
            status: 429,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "retry-after": String(
                rateRetryAfterSeconds
              ),
              "cache-control": "no-store"
            }
          }
        );
      }
      const periodKey = entitlement.current_period_end || (/* @__PURE__ */ new Date()).toISOString().slice(0, 7);
      const ONCE_MAX_EXECUTE_BODY_BYTES = 64 * 1024;
      const ONCE_MAX_OPERATION_ID_BYTES = 200;
      const ONCE_MAX_ACTION_BYTES = 32 * 1024;
      const declaredContentLength = Number(
        request.headers.get(
          "content-length"
        ) || 0
      );
      if (Number.isFinite(
        declaredContentLength
      ) && declaredContentLength > ONCE_MAX_EXECUTE_BODY_BYTES) {
        return json(
          {
            error: "request_too_large",
            max_bytes: ONCE_MAX_EXECUTE_BODY_BYTES
          },
          413
        );
      }
      let rawExecuteBody;
      try {
        rawExecuteBody = await request.clone().arrayBuffer();
      } catch {
        return json(
          {
            error: "request_body_unreadable"
          },
          400
        );
      }
      if (rawExecuteBody.byteLength > ONCE_MAX_EXECUTE_BODY_BYTES) {
        return json(
          {
            error: "request_too_large",
            max_bytes: ONCE_MAX_EXECUTE_BODY_BYTES
          },
          413
        );
      }
      let usageBody;
      try {
        usageBody = JSON.parse(
          new TextDecoder().decode(
            rawExecuteBody
          )
        );
      } catch {
        return json(
          {
            error: "invalid_json"
          },
          400
        );
      }
      if (!usageBody || typeof usageBody !== "object" || Array.isArray(usageBody)) {
        return json(
          {
            error: "invalid_request",
            message: "request body must be a JSON object"
          },
          400
        );
      }
      const operationId = String(
        usageBody.operation_id || ""
      ).trim();
      if (!operationId) {
        return json(
          {
            error: "operation_id_required"
          },
          400
        );
      }
      const operationIdBytes = new TextEncoder().encode(
        operationId
      ).byteLength;
      if (operationIdBytes > ONCE_MAX_OPERATION_ID_BYTES) {
        return json(
          {
            error: "invalid_operation_id",
            message: "operation_id exceeds maximum length",
            max_bytes: ONCE_MAX_OPERATION_ID_BYTES
          },
          400
        );
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(
        operationId
      )) {
        return json(
          {
            error: "invalid_operation_id",
            message: "operation_id contains unsupported characters"
          },
          400
        );
      }
      const providerName = String(
        usageBody.provider || "blind_test"
      ).trim().toLowerCase();
      const builtInProviders = /* @__PURE__ */ new Set([
        "blind_test",
        "http_v1",
        "stripe_v1"
      ]);
      const registeredAliasSyntaxValid = /^[a-z0-9][a-z0-9._-]{0,62}$/.test(
        providerName
      );
      if (!builtInProviders.has(
        providerName
      ) && !registeredAliasSyntaxValid) {
        return json(
          {
            error: "unsupported_provider",
            provider: providerName
          },
          400
        );
      }
      const semanticAction = usageBody.action === void 0 ? {} : usageBody.action;
      if (semanticAction === null || typeof semanticAction !== "object" || Array.isArray(semanticAction)) {
        return json(
          {
            error: "invalid_action",
            message: "action must be a JSON object"
          },
          400
        );
      }
      const semanticActionBytes = new TextEncoder().encode(
        JSON.stringify(
          semanticAction
        )
      ).byteLength;
      if (semanticActionBytes > ONCE_MAX_ACTION_BYTES) {
        return json(
          {
            error: "action_too_large",
            max_bytes: ONCE_MAX_ACTION_BYTES
          },
          413
        );
      }
      const semanticHash = await onceSemanticHash(
        providerName,
        semanticAction
      );
      let semanticBinding = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          provider,
                                          resolved_provider,
                                          semantic_hash,
                                          created_at
                                  FROM operation_semantics
                                  WHERE
                                          customer_id = ?
                                          AND operation_id = ?
                                  LIMIT 1
                                  `,
          keyRecord.customer_id,
          operationId
        )
      ][0];
      if (semanticBinding && (semanticBinding.provider !== providerName || semanticBinding.semantic_hash !== semanticHash)) {
        await this.onceLog(
          "once.execute.identity_conflict",
          {
            operationId,
            provider: providerName,
            status: 409,
            result: "operation_identity_conflict"
          }
        );
        return json(
          {
            error: "operation_identity_conflict",
            operation_id: operationId,
            message: "this operation_id is already bound to a different semantic action"
          },
          409
        );
      }
      let resolvedProvider = "";
      if (semanticBinding) {
        resolvedProvider = String(
          semanticBinding.resolved_provider || ""
        ).trim().toLowerCase();
        if (!resolvedProvider) {
          if (builtInProviders.has(
            providerName
          )) {
            resolvedProvider = providerName;
          } else {
            return json(
              {
                error: "resolved_provider_missing",
                operation_id: operationId
              },
              503
            );
          }
        }
      } else if (builtInProviders.has(
        providerName
      )) {
        resolvedProvider = providerName;
      } else {
        const providerAlias = [
          ...this.ctx.storage.sql.exec(
            `
                                          SELECT
                                                  pa.current_version_id,
                                                  pv.provider_type
                                          FROM provider_aliases AS pa
                                          JOIN provider_versions AS pv
                                                  ON pv.version_id =
                                                     pa.current_version_id
                                                  AND pv.customer_id =
                                                     pa.customer_id
                                                  AND pv.provider_name =
                                                     pa.provider_name
                                          WHERE
                                                  pa.customer_id = ?
                                                  AND pa.provider_name = ?
                                                  AND pa.disabled_at IS NULL
                                          LIMIT 1
                                          `,
            keyRecord.customer_id,
            providerName
          )
        ][0];
        if (!providerAlias) {
          return json(
            {
              error: "provider_not_found",
              provider: providerName
            },
            404
          );
        }
        if (String(
          providerAlias.provider_type || ""
        ).trim().toLowerCase() !== "http_v1") {
          return json(
            {
              error: "provider_alias_resolution_failed",
              provider: providerName
            },
            503
          );
        }
        const versionId = String(
          providerAlias.current_version_id || ""
        ).trim().toLowerCase();
        if (!/^pv_[a-f0-9]{32}$/.test(
          versionId
        )) {
          return json(
            {
              error: "provider_alias_resolution_failed",
              provider: providerName
            },
            503
          );
        }
        resolvedProvider = "registered_http_v1:" + versionId;
      }
      const alreadyMetered = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT
                                          operation_id
                                  FROM usage_operations
                                  WHERE
                                          customer_id = ?
                                          AND period_key = ?
                                          AND operation_id = ?
                                  LIMIT 1
                                  `,
          keyRecord.customer_id,
          periodKey,
          operationId
        )
      ][0];
      const currentUsage = [
        ...this.ctx.storage.sql.exec(
          `
                                  SELECT used
                                  FROM usage_monthly
                                  WHERE
                                          customer_id = ?
                                          AND period_key = ?
                                  LIMIT 1
                                  `,
          keyRecord.customer_id,
          periodKey
        )
      ][0];
      const used = Number(
        currentUsage?.used || 0
      );
      let usageAfter = used;
      if (!alreadyMetered) {
        if (used >= monthlyLimit) {
          await this.onceLog(
            "once.execute.monthly_limit",
            {
              operationId,
              provider: providerName,
              status: 429,
              result: "monthly_limit_exceeded"
            }
          );
          return json(
            {
              error: "monthly_limit_exceeded",
              plan,
              used,
              limit: monthlyLimit,
              period: periodKey
            },
            429
          );
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        this.ctx.storage.sql.exec(
          `
                                  INSERT OR IGNORE
                                  INTO usage_operations (
                                          customer_id,
                                          period_key,
                                          operation_id,
                                          created_at
                                  )
                                  VALUES (?, ?, ?, ?)
                                  `,
          keyRecord.customer_id,
          periodKey,
          operationId,
          now
        );
        const insertResult = [
          ...this.ctx.storage.sql.exec(
            `
                                          SELECT changes() AS changes
                                          `
          )
        ][0];
        const wasInserted = Number(
          insertResult?.changes || 0
        ) === 1;
        if (wasInserted) {
          this.ctx.storage.sql.exec(
            `
                                          INSERT INTO usage_monthly (
                                                  customer_id,
                                                  period_key,
                                                  used,
                                                  updated_at
                                          )
                                          VALUES (?, ?, 1, ?)

                                          ON CONFLICT(
                                                  customer_id,
                                                  period_key
                                          )
                                          DO UPDATE SET
                                                  used =
                                                      usage_monthly.used + 1,

                                                  updated_at =
                                                      excluded.updated_at
                                          `,
            keyRecord.customer_id,
            periodKey,
            now
          );
        }
        const refreshedUsage = [
          ...this.ctx.storage.sql.exec(
            `
                                          SELECT used
                                          FROM usage_monthly
                                          WHERE
                                                  customer_id = ?
                                                  AND period_key = ?
                                          LIMIT 1
                                          `,
            keyRecord.customer_id,
            periodKey
          )
        ][0];
        usageAfter = Number(
          refreshedUsage?.used || used
        );
      }
      if (!semanticBinding) {
        const semanticCreatedAt = (/* @__PURE__ */ new Date()).toISOString();
        this.ctx.storage.sql.exec(
          `
                                  INSERT OR IGNORE
                                  INTO operation_semantics (
                                          customer_id,
                                          operation_id,
                                          provider,
                                          resolved_provider,
                                          semantic_hash,
                                          created_at
                                  )
                                  VALUES (?, ?, ?, ?, ?, ?)
                                  `,
          keyRecord.customer_id,
          operationId,
          providerName,
          resolvedProvider,
          semanticHash,
          semanticCreatedAt
        );
        semanticBinding = [
          ...this.ctx.storage.sql.exec(
            `
                                          SELECT
                                          provider,
                                          resolved_provider,
                                          semantic_hash,
                                          created_at
                                  FROM operation_semantics
                                          WHERE
                                                  customer_id = ?
                                                  AND operation_id = ?
                                          LIMIT 1
                                          `,
            keyRecord.customer_id,
            operationId
          )
        ][0];
        if (!semanticBinding) {
          return json(
            {
              error: "semantic_binding_failed",
              operation_id: operationId
            },
            503
          );
        }
        if (semanticBinding.provider !== providerName || semanticBinding.semantic_hash !== semanticHash) {
          await this.onceLog(
            "once.execute.identity_conflict",
            {
              operationId,
              provider: providerName,
              status: 409,
              result: "operation_identity_conflict"
            }
          );
          return json(
            {
              error: "operation_identity_conflict",
              operation_id: operationId,
              message: "this operation_id is already bound to a different semantic action"
            },
            409
          );
        }
      }
      const authoritativeResolvedProvider = String(
        semanticBinding?.resolved_provider || ""
      ).trim().toLowerCase();
      if (authoritativeResolvedProvider) {
        resolvedProvider = authoritativeResolvedProvider;
      } else if (builtInProviders.has(
        providerName
      )) {
        resolvedProvider = providerName;
      } else {
        return json(
          {
            error: "resolved_provider_missing",
            operation_id: operationId
          },
          503
        );
      }
      const scopedOperationId = await onceTenantScopedOperationId(
        keyRecord.customer_id,
        operationId
      );
      const scopedBody = {
        ...usageBody,
        provider: resolvedProvider,
        operation_id: scopedOperationId
      };
      const downstream = await this.fetch(
        new Request(
          "https://q18.internal/execute",
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify(
              scopedBody
            )
          }
        )
      );
      const headers = new Headers(
        downstream.headers
      );
      headers.set(
        "x-once-plan",
        plan
      );
      headers.set(
        "x-once-usage-limit",
        String(monthlyLimit)
      );
      headers.set(
        "x-once-usage-used",
        String(usageAfter)
      );
      const downstreamText = await downstream.text();
      let customerResponseBody = downstreamText;
      try {
        const parsed = JSON.parse(
          downstreamText
        );
        if (parsed && typeof parsed === "object") {
          parsed.operation_id = operationId;
          if (this.isHttpResponseReplayRequired(
            scopedOperationId
          )) {
            const customerReplay = this.getHttpResponseReplay(
              scopedOperationId
            );
            if (customerReplay) {
              parsed.http_response = customerReplay;
            }
          }
          customerResponseBody = JSON.stringify(
            parsed
          );
        }
      } catch {
      }
      headers.delete(
        "content-length"
      );
      return new Response(
        customerResponseBody,
        {
          status: downstream.status,
          statusText: downstream.statusText,
          headers
        }
      );
    }
    if (request.method === "POST" && url.pathname === "/execute") {
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
        body.operation_id || ""
      ).trim();
      if (!operationId) {
        return json(
          {
            error: "operation_id_required"
          },
          400
        );
      }
      const requestedProvider = String(
        body.provider || "blind_test"
      ).trim().toLowerCase();
      const coreSupportedProviders = /* @__PURE__ */ new Set([
        "blind_test",
        "http_v1",
        "stripe_v1"
      ]);
      const registeredProviderIdentityValid = /^registered_http_v1:pv_[a-f0-9]{32}$/.test(
        requestedProvider
      );
      if (!coreSupportedProviders.has(
        requestedProvider
      ) && !registeredProviderIdentityValid) {
        return json(
          {
            error: "unsupported_provider",
            provider: requestedProvider,
            allowed: [
              ...coreSupportedProviders
            ]
          },
          400
        );
      }
      const fault = String(
        body.fault || "normal"
      ).trim();
      const allowedFaults = /* @__PURE__ */ new Set([
        "normal",
        "fail_before_effect",
        "fail_after_effect"
      ]);
      if (!allowedFaults.has(fault)) {
        return json(
          {
            error: "invalid_fault",
            allowed: [
              ...allowedFaults
            ]
          },
          400
        );
      }
      const delayMs = Math.min(
        Math.max(
          Number(
            body.delay_ms || 0
          ),
          0
        ),
        1e4
      );
      const now = (/* @__PURE__ */ new Date()).toISOString();
      let operation = this.getOperation(
        operationId
      );
      const operationProvider = operation ? String(
        operation.provider || "blind_test"
      ).trim().toLowerCase() : requestedProvider;
      if (operation && operationProvider !== requestedProvider) {
        return json(
          {
            error: "provider_identity_conflict",
            operation_id: operationId,
            stored_provider: operationProvider,
            requested_provider: requestedProvider,
            message: "this operation_id is already bound to a different provider"
          },
          409
        );
      }
      if (operationProvider.startsWith(
        "registered_http_v1:"
      )) {
        const action = body.action === void 0 ? {} : body.action;
        if (!action || typeof action !== "object" || Array.isArray(action)) {
          return json(
            {
              error: "invalid_http_write_v1_action",
              operation_id: operationId,
              message: "registered HTTP execution requires a structured http_write_v1 action"
            },
            400
          );
        }
        const actionType = String(
          action.type || ""
        ).trim();
        const actionMethod = String(
          action.method || ""
        ).trim().toUpperCase();
        const rawTargetUrl = String(
          action.url || ""
        ).trim();
        if (actionType !== "http_write_v1" || actionMethod !== "POST" || !rawTargetUrl || typeof action.body_json !== "string") {
          return json(
            {
              error: "invalid_http_write_v1_action",
              operation_id: operationId,
              message: "registered HTTP v0.1 supports POST + JSON body only"
            },
            400
          );
        }
        try {
          JSON.parse(
            action.body_json
          );
        } catch {
          return json(
            {
              error: "invalid_http_write_v1_body_json",
              operation_id: operationId
            },
            400
          );
        }
        let registeredHttpConfig;
        try {
          registeredHttpConfig = await this.getRegisteredHttpV1Config(
            operationProvider
          );
        } catch (error) {
          await this.onceLog(
            "once.execute.http_authorization_unavailable",
            {
              operationId,
              provider: operationProvider,
              status: 503,
              result: "http_authorization_unavailable"
            }
          );
          return json(
            {
              error: "http_authorization_unavailable",
              operation_id: operationId,
              message: "registered provider authorization could not be resolved; execution was not attempted"
            },
            503
          );
        }
        const allowedUrls = Array.isArray(
          registeredHttpConfig?.allowedUrls
        ) ? registeredHttpConfig.allowedUrls.map(
          (value) => String(
            value || ""
          ).trim()
        ).filter(Boolean) : [];
        if (allowedUrls.length === 0) {
          await this.onceLog(
            "once.execute.http_target_denied",
            {
              operationId,
              provider: operationProvider,
              status: 403,
              result: "http_target_not_authorized",
              reason: "provider_allowlist_empty"
            }
          );
          return json(
            {
              error: "http_target_not_authorized",
              operation_id: operationId,
              reason: "provider_allowlist_empty",
              message: "registered provider has no authorized HTTP targets; execution was not attempted"
            },
            403
          );
        }
        let parsedTargetUrl;
        try {
          parsedTargetUrl = new URL(
            rawTargetUrl
          );
        } catch {
          return json(
            {
              error: "http_target_url_invalid",
              operation_id: operationId
            },
            400
          );
        }
        if (parsedTargetUrl.protocol !== "https:") {
          return json(
            {
              error: "http_target_must_be_https",
              operation_id: operationId
            },
            400
          );
        }
        if (parsedTargetUrl.username || parsedTargetUrl.password || parsedTargetUrl.hash) {
          return json(
            {
              error: "http_target_url_invalid_components",
              operation_id: operationId
            },
            400
          );
        }
        parsedTargetUrl.searchParams.sort();
        const canonicalTargetUrl = parsedTargetUrl.toString();
        if (!allowedUrls.includes(
          canonicalTargetUrl
        )) {
          await this.onceLog(
            "once.execute.http_target_denied",
            {
              operationId,
              provider: operationProvider,
              status: 403,
              result: "http_target_not_authorized",
              reason: "target_not_in_provider_allowlist"
            }
          );
          return json(
            {
              error: "http_target_not_authorized",
              operation_id: operationId,
              reason: "target_not_in_provider_allowlist",
              message: "HTTP target is not authorized by this immutable provider version; execution was not attempted"
            },
            403
          );
        }
      }
      // Fast replay is permitted only when BOTH:
      //
      // 1. the durable operation ledger is CONFIRMED
      // 2. an immutable confirmation receipt proves one effect
      //
      // If HTTP replay is required, its durable response envelope
      // must also exist. Any missing evidence falls through to the
      // existing external provider-truth path.
      if (
        operation &&
        operation.state === "CONFIRMED"
      ) {
        let localReceipt;

        try {
          localReceipt =
            this.getConfirmationReceipt(
              operationId
            );
        } catch {
          localReceipt = void 0;
        }

        const localReplayRequired =
          this.isHttpResponseReplayRequired(
            operationId
          );

        const localReplayAvailable =
          !localReplayRequired ||
          Boolean(
            this.getHttpResponseReplay(
              operationId
            )
          );

        if (
          localReceipt &&
          localReceipt.provider ===
            operationProvider &&
          localReceipt.side_effects === 1 &&
          localReplayAvailable
        ) {
          this.ctx.storage.sql.exec(
            `
                          UPDATE operations
                          SET
                                  attempts =
                                      attempts + 1,
                                  last_attempt_at = ?
                          WHERE operation_id = ?
                          `,
            now,
            operationId
          );

          operation =
            this.getOperation(
              operationId
            );

          await this.onceLog(
            "once.execute.already_confirmed",
            {
              operationId,
              provider:
                operationProvider,
              state:
                "CONFIRMED",
              attempts:
                operation
                  ? operation.attempts
                  : 0,
              status:
                200,
              result:
                "already_executed"
            }
          );

          return json({
            operation_id:
              operationId,

            result:
              "already_executed",

            state:
              "CONFIRMED",

            attempts:
              operation.attempts,

            side_effects:
              localReceipt.side_effects,

            first_executed_at:
              localReceipt.executed_at,

            last_attempt_at:
              operation.last_attempt_at
          });
        }
      }

      let provider;
      try {
        provider = await this.getProvider(
          operationProvider,
          operationId
        );
      } catch (error) {
        operation = this.getOperation(operationId);
        const providerTruthError = String(
          error?.message || "provider_truth_unavailable"
        );
        if (operation && operation.state === "CONFIRMED") {
          this.ctx.storage.sql.exec(
            `
                                          UPDATE operations
                                          SET
                                                  attempts = attempts + 1,
                                                  last_attempt_at = ?
                                          WHERE operation_id = ?
                                          `,
            now,
            operationId
          );
          operation = this.getOperation(
            operationId
          );
          await this.onceLog(
            "once.execute.already_confirmed",
            {
              operationId,
              provider: operationProvider,
              state: "CONFIRMED",
              attempts: operation ? operation.attempts : 0,
              status: 200,
              result: "already_executed_local"
            }
          );
          return json({
            operation_id: operationId,
            result: "already_executed_local",
            state: "CONFIRMED",
            attempts: operation.attempts,
            side_effects: null,
            provider_truth: "unavailable",
            provider_error: providerTruthError,
            message: "local ledger already confirms execution; provider execution was not attempted"
          });
        }
        if (operation) {
          this.ctx.storage.sql.exec(
            `
                                          UPDATE operations
                                          SET
                                                  attempts = attempts + 1,

                                                  state =
                                                      CASE
                                                          WHEN state IN (
                                                              'EXECUTING',
                                                              'UNKNOWN'
                                                          )
                                                          THEN 'UNKNOWN'
                                                          ELSE state
                                                      END,

                                                  last_attempt_at = ?
                                          WHERE operation_id = ?
                                          `,
            now,
            operationId
          );
          operation = this.getOperation(
            operationId
          );
        }
        if (operation && operation.state === "UNKNOWN") {
          await this.enqueueUnknownReconciliation(
            operationId
          );
        }
        await this.onceLog(
          operation && operation.state === "UNKNOWN" ? "once.execute.blocked_provider_truth_unavailable" : "once.execute.provider_truth_unavailable",
          {
            operationId,
            provider: operationProvider,
            state: operation ? operation.state : "ABSENT",
            attempts: operation ? operation.attempts : 0,
            status: 503,
            result: operation && operation.state === "UNKNOWN" ? "blocked_provider_truth_unavailable" : "provider_truth_unavailable"
          }
        );
        return json(
          {
            operation_id: operationId,
            result: operation && operation.state === "UNKNOWN" ? "blocked_provider_truth_unavailable" : "provider_truth_unavailable",
            state: operation ? operation.state : "ABSENT",
            attempts: operation ? operation.attempts : 0,
            side_effects: null,
            provider_truth: "unavailable",
            provider_error: providerTruthError,
            message: "provider truth unavailable; provider execution was not attempted"
          },
          503
        );
      }
      // Provider I/O permits other requests to run. Re-read durable truth.
      operation = this.getOperation(operationId);
      if (operation && operation.provider !== operationProvider) {
        return json({ error: "provider_identity_conflict", operation_id: operationId }, 409);
      }
      if (provider) {
        // Provider truth is authoritative proof of one effect.
        // Persist it as an optimisation receipt. Failure to cache
        // must never change the existing safety path.
        try {
          this.recordConfirmationReceipt(
            operationId,
            operationProvider,
            provider,
            now
          );
        } catch {
        }

        const providerTruthReplayRequired = this.isHttpResponseReplayRequired(
          operationId
        );
        const providerTruthReplay = providerTruthReplayRequired ? this.getHttpResponseReplay(
          operationId
        ) : null;
        if (providerTruthReplayRequired && !providerTruthReplay) {
          if (operation) {
            this.ctx.storage.sql.exec(
              `
                                                  UPDATE operations
                                                  SET
                                                          attempts =
                                                              attempts + 1,

                                                          state =
                                                              'UNKNOWN',

                                                          last_attempt_at = ?
                                                  WHERE operation_id = ?
                                                  `,
              now,
              operationId
            );
          } else {
            this.insertOperation(
              operationId,
              "UNKNOWN",
              now,
              operationProvider
            );
          }
          operation = this.getOperation(
            operationId
          );
          if (operation && operation.state === "UNKNOWN") {
            await this.enqueueUnknownReconciliation(
              operationId
            );
          }
          await this.onceLog(
            "once.execute.replay_missing_quarantined",
            {
              operationId,
              provider: operationProvider,
              state: "UNKNOWN",
              attempts: operation ? operation.attempts : 0,
              status: 409,
              result: "replay_required_missing"
            }
          );
          return json(
            {
              operation_id: operationId,
              result: "replay_required_missing",
              state: "UNKNOWN",
              attempts: operation ? operation.attempts : 0,
              side_effects: provider.side_effects,
              message: "provider truth confirms the effect, but the replay-required HTTP response is missing"
            },
            409
          );
        }
        if (operation) {
          this.ctx.storage.sql.exec(
            `
						UPDATE operations
						SET
							attempts =
								attempts + 1,
							state =
								'CONFIRMED',
							last_attempt_at = ?
						WHERE
							operation_id = ?
						`,
            now,
            operationId
          );
        } else {
          this.insertOperation(
            operationId,
            "CONFIRMED",
            now,
            operationProvider
          );
        }
        operation = this.getOperation(
          operationId
        );
        await this.onceLog(
          "once.execute.already_confirmed",
          {
            operationId,
            provider: operationProvider,
            state: "CONFIRMED",
            attempts: operation ? operation.attempts : 0,
            status: 200,
            result: "already_executed"
          }
        );
        return json({
          operation_id: operationId,
          result: "already_executed",
          state: operation.state,
          attempts: operation.attempts,
          side_effects: provider.side_effects,
          first_executed_at: provider.executed_at,
          last_attempt_at: operation.last_attempt_at
        });
      }
      if (operation && operation.state === "CONFIRMED") {
        this.ctx.storage.sql.exec(
          `
UPDATE operations
SET
attempts = attempts + 1,
last_attempt_at = ?
WHERE operation_id = ?
`,
          now,
          operationId
        );
        operation = this.getOperation(
          operationId
        );
        await this.onceLog(
          "once.execute.already_confirmed",
          {
            operationId,
            provider: operationProvider,
            state: "CONFIRMED",
            attempts: operation ? operation.attempts : 0,
            status: 200,
            result: "already_executed_local"
          }
        );
        return json({
          operation_id: operationId,
          result: "already_executed_local",
          state: "CONFIRMED",
          attempts: operation.attempts,
          side_effects: null,
          message: "local ledger already confirms execution; provider negative truth ignored"
        });
      }
      if (operation && (operation.state === "EXECUTING" || operation.state === "UNKNOWN")) {
        this.ctx.storage.sql.exec(
          `
UPDATE operations
SET
attempts = attempts + 1,
state = 'UNKNOWN',
last_attempt_at = ?
WHERE operation_id = ?
`,
          now,
          operationId
        );
        operation = this.getOperation(
          operationId
        );
        if (operation && operation.state === "UNKNOWN") {
          await this.enqueueUnknownReconciliation(
            operationId
          );
        }
        await this.onceLog(
          "once.execute.blocked_ambiguous",
          {
            operationId,
            provider: operationProvider,
            state: "UNKNOWN",
            attempts: operation ? operation.attempts : 0,
            status: 409,
            result: "blocked_ambiguous"
          }
        );
        return json(
          {
            operation_id: operationId,
            result: "blocked_ambiguous",
            state: "UNKNOWN",
            attempts: operation.attempts,
            side_effects: null,
            message: "execution may already have occurred; retry blocked despite negative provider truth"
          },
          409
        );
      }
      if (!operation) {
        this.insertOperation(
          operationId,
          "PREPARED",
          now,
          operationProvider
        );
      } else {
        this.ctx.storage.sql.exec(
          `
					UPDATE operations
					SET
						attempts =
							attempts + 1,
						last_attempt_at = ?
					WHERE
						operation_id = ?
					`,
          now,
          operationId
        );
      }
      operation = this.getOperation(
        operationId
      );
      let registeredHttpReplayRequired = false;
      if (operationProvider.startsWith(
        "registered_http_v1:"
      )) {
        const registeredHttpConfig = await this.getRegisteredHttpV1Config(
          operationProvider
        );
        registeredHttpReplayRequired = registeredHttpConfig.responseReplay === "required";
      }
      if (registeredHttpReplayRequired) {
        this.requireHttpResponseReplay(
          operationId,
          now
        );
      }
      // This conditional transition, not the earlier provider snapshot, grants
      // execution authority. It also covers the config-decryption await above.
      // EXECUTING/UNKNOWN are never reclaimed on timeout or negative truth.
      const claimed = [...this.ctx.storage.sql.exec(
        `UPDATE operations SET state = 'EXECUTING'
         WHERE operation_id = ? AND provider = ?
           AND state IN ('PREPARED', 'FAILED_BEFORE_EFFECT')
         RETURNING operation_id`,
        operationId, operationProvider
      )];
      if (claimed.length !== 1) {
        operation = this.getOperation(operationId);
        return json({
          operation_id: operationId,
          result: "execution_claim_unavailable",
          state: operation?.state || "UNKNOWN",
          message: "operation changed during preflight; retry through Once with the same identity"
        }, 409);
      }
      // Explicitly flush the durable claim before an outbound request can escape.
      // A crash after this point leaves an unreclaimable ambiguous operation.
      await this.ctx.storage.sync();
      if (fault === "fail_before_effect") {
        this.ctx.storage.sql.exec(
          `
					UPDATE operations
					SET state =
						'FAILED_BEFORE_EFFECT'
					WHERE
						operation_id = ? AND state IN ('EXECUTING', 'UNKNOWN')
					`,
          operationId
        );
        operation = this.getOperation(
          operationId
        );
        return json(
          {
            operation_id: operationId,
            result: "injected_failure",
            fault: "fail_before_effect",
            state: "FAILED_BEFORE_EFFECT",
            attempts: operation.attempts,
            side_effects: 0
          },
          503
        );
      }
      try {
        provider = await this.executeProvider(
          operationProvider,
          operationId,
          body.action === void 0 ? {} : body.action
        );
      } catch (error) {
        if (error?.once_failure_class === "FAILED_BEFORE_EFFECT") {
          this.ctx.storage.sql.exec(
            `
                                           UPDATE operations
                                           SET state =
                                                   'FAILED_BEFORE_EFFECT'
                                           WHERE operation_id = ? AND state IN ('EXECUTING', 'UNKNOWN')
                                           `,
            operationId
          );
          operation = this.getOperation(
            operationId
          );
          const providerStatus = Number(
            error?.provider_status || 409
          );
          const responseStatus = Number.isInteger(
            providerStatus
          ) && providerStatus >= 400 && providerStatus <= 599 ? providerStatus : 409;
          await this.onceLog(
            "once.execute.provider_rejected_before_effect",
            {
              operationId,
              provider: operationProvider,
              state: "FAILED_BEFORE_EFFECT",
              attempts: operation ? operation.attempts : 0,
              status: responseStatus,
              result: "provider_rejected_before_effect"
            }
          );
          return json(
            {
              operation_id: operationId,
              result: "provider_rejected_before_effect",
              state: "FAILED_BEFORE_EFFECT",
              attempts: operation ? operation.attempts : 0,
              side_effects: 0,
              provider_executed: false,
              provider_outcome: "rejected_before_effect",
              provider_status: providerStatus,
              provider_error: String(
                error?.message || "provider_rejected_before_effect"
              ),
              message: "provider explicitly proved that no side effect occurred; retry remains safe"
            },
            responseStatus
          );
        }
        this.ctx.storage.sql.exec(
          `
                                  UPDATE operations
                                  SET state = 'UNKNOWN'
                                  WHERE operation_id = ? AND state IN ('EXECUTING', 'UNKNOWN')
                                  `,
          operationId
        );
        operation = this.getOperation(
          operationId
        );
        if (operation && operation.state === "UNKNOWN") {
          await this.enqueueUnknownReconciliation(
            operationId
          );
        }
        await this.onceLog(
          "once.execute.provider_ambiguous",
          {
            operationId,
            provider: operationProvider,
            state: "UNKNOWN",
            attempts: operation ? operation.attempts : 0,
            status: 503,
            result: "provider_execute_ambiguous"
          }
        );
        return json(
          {
            operation_id: operationId,
            result: "provider_execute_ambiguous",
            state: "UNKNOWN",
            attempts: operation ? operation.attempts : 0,
            side_effects: null,
            provider_error: String(
              error?.message || "provider_execute_failed"
            ),
            message: "provider call failed after execution began; outcome is ambiguous and must be reconciled from provider truth"
          },
          503
        );
      }
      if (delayMs > 0) {
        await sleep(
          delayMs
        );
      }
      if (fault === "fail_after_effect") {
        this.ctx.storage.sql.exec(
          `
					UPDATE operations
					SET state = 'UNKNOWN'
					WHERE operation_id = ? AND state IN ('EXECUTING', 'UNKNOWN')
					`,
          operationId
        );
        operation = this.getOperation(
          operationId
        );
        if (operation && operation.state === "UNKNOWN") {
          await this.enqueueUnknownReconciliation(
            operationId
          );
        }
        return json(
          {
            operation_id: operationId,
            result: "injected_failure",
            fault: "fail_after_effect",
            state: "UNKNOWN",
            attempts: operation.attempts,
            message: "connection outcome ambiguous after provider effect"
          },
          503
        );
      }
      const httpReplayRequiredForConfirmation = this.isHttpResponseReplayRequired(
        operationId
      );
      if (httpReplayRequiredForConfirmation) {
        try {
          const envelope = provider && provider.http_response;
          if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
            throw new Error(
              "http_response_replay_envelope_required"
            );
          }
          if (typeof envelope.body_text !== "string") {
            throw new Error(
              "http_response_replay_body_text_required"
            );
          }
          this.ctx.storage.transactionSync(
            () => {
              this.recordHttpResponseReplay(
                operationId,
                {
                  status: envelope.status,
                  bodyText: envelope.body_text,
                  headers: envelope.headers || {},
                  recordedAt: now
                }
              );
              this.ctx.storage.sql.exec(
                `
                                                          UPDATE operations
                                                          SET state =
                                                                  'CONFIRMED'
                                                          WHERE
                                                                  operation_id = ?
                                                                  AND state IN ('EXECUTING', 'UNKNOWN')
                                                          `,
                operationId
              );
              const confirmed = this.getOperation(
                operationId
              );
              if (!confirmed || confirmed.state !== "CONFIRMED") {
                throw new Error(
                  "http_response_replay_confirmation_state_mismatch"
                );
              }
            }
          );
        } catch (error) {
          this.ctx.storage.sql.exec(
            `
                                          UPDATE operations
                                          SET state =
                                                  'UNKNOWN'
                                          WHERE
                                                  operation_id = ?
                                                  AND state =
                                                      'EXECUTING'
                                          `,
            operationId
          );
          operation = this.getOperation(
            operationId
          );
          if (operation && operation.state === "UNKNOWN") {
            await this.enqueueUnknownReconciliation(
              operationId
            );
          }
          await this.onceLog(
            "once.execute.http_replay_commit_failed",
            {
              operationId,
              provider: operationProvider,
              state: "UNKNOWN",
              attempts: operation ? operation.attempts : 0,
              status: 503,
              result: "http_response_replay_commit_failed"
            }
          );
          return json(
            {
              operation_id: operationId,
              result: "http_response_replay_commit_failed",
              state: "UNKNOWN",
              attempts: operation ? operation.attempts : 0,
              side_effects: null,
              provider_error: String(
                error?.message || "http_response_replay_commit_failed"
              ),
              message: "provider execution completed, but the replay-required HTTP result could not be durably committed; retry execution is blocked"
            },
            503
          );
        }
      } else {
        this.ctx.storage.sql.exec(
          `
                                  UPDATE operations
                                  SET state =
                                          'CONFIRMED'
                                  WHERE operation_id = ?
                                  `,
          operationId
        );
      }
      operation = this.getOperation(
        operationId
      );

      // Confirmation itself remains authoritative even if this
      // optimisation receipt cannot be written. In that case the
      // next retry simply falls back to provider truth.
      try {
        this.recordConfirmationReceipt(
          operationId,
          operationProvider,
          provider,
          now
        );
      } catch {
      }

      await this.onceLog(
        "once.execute.confirmed",
        {
          operationId,
          provider: operationProvider,
          state: "CONFIRMED",
          attempts: operation ? operation.attempts : 0,
          status: 200,
          result: "executed"
        }
      );
      return json({
        operation_id: operationId,
        result: "executed",
        state: "CONFIRMED",
        attempts: operation.attempts,
        side_effects: provider.side_effects,
        executed_at: provider.executed_at
      });
    }
    if (request.method === "GET" && url.pathname.startsWith(
      "/truth/"
    )) {
      const operationId = decodeURIComponent(
        url.pathname.substring(
          "/truth/".length
        )
      );
      const operation = this.getOperation(
        operationId
      );
      const provider = await this.getProvider(
        this.getOperationProvider(
          operationId
        ),
        operationId
      );
      return json({
        operation_id: operationId,
        attempts: operation ? operation.attempts : 0,
        ledger_state: operation ? operation.state : "ABSENT",
        side_effects: provider ? provider.side_effects : 0,
        provider_executed: Boolean(provider),
        provider_executed_at: provider ? provider.executed_at : null,
        first_attempt_at: operation ? operation.first_attempt_at : null,
        last_attempt_at: operation ? operation.last_attempt_at : null
      });
    }
    return json(
      {
        error: "not_found"
      },
      404
    );
  }
};
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        service: "ONCE-Q18 ambiguity test service",
        status: "online",
        mode: "persistent-synthetic-fault-injection",
        ledger: "Cloudflare Durable Object / SQLite",
        fault_modes: [
          "normal",
          "fail_before_effect",
          "fail_after_effect"
        ],
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    const id = env.Q18_TRUTH.idFromName(
      "once-q18-authoritative-ledger-v1"
    );
    const stub = env.Q18_TRUTH.get(id);
    if (request.method === "POST" && url.pathname === "/stripe/webhook") {
      if (!env.STRIPE_WEBHOOK_SECRET) {
        return json(
          {
            error: "stripe_webhook_secret_missing"
          },
          503
        );
      }
      const rawBody = await request.text();
      const signature = request.headers.get(
        "stripe-signature"
      );
      const valid = await verifyStripeWebhookSignature(
        rawBody,
        signature,
        env.STRIPE_WEBHOOK_SECRET
      );
      if (!valid) {
        return json(
          {
            error: "invalid_stripe_signature"
          },
          400
        );
      }
      try {
        JSON.parse(rawBody);
      } catch {
        return json(
          {
            error: "invalid_stripe_json"
          },
          400
        );
      }
      return stub.fetch(
        new Request(
          "https://q18.internal/stripe/event",
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
      "/stripe/entitlement/"
    )) {
      if (!env.ONCE_ADMIN_SECRET) {
        return json(
          {
            error: "once_admin_secret_missing"
          },
          503
        );
      }
      const supplied = request.headers.get(
        "x-once-admin-secret"
      ) || "";
      if (!stripeTimingSafeHexEqual(
        supplied,
        env.ONCE_ADMIN_SECRET
      )) {
        return json(
          {
            error: "admin_unauthorized"
          },
          403
        );
      }
      const customerId = url.pathname.substring(
        "/stripe/entitlement/".length
      );
      return stub.fetch(
        new Request(
          "https://q18.internal/stripe/entitlement/" + encodeURIComponent(customerId),
          {
            method: "GET"
          }
        )
      );
    }
    if (request.method === "POST" && url.pathname === "/admin/api-keys/revoke") {
      if (!env.ONCE_ADMIN_SECRET) {
        return json(
          {
            error: "once_admin_secret_missing"
          },
          503
        );
      }
      const supplied = request.headers.get(
        "x-once-admin-secret"
      ) || "";
      if (!stripeTimingSafeHexEqual(
        supplied,
        env.ONCE_ADMIN_SECRET
      )) {
        return json(
          {
            error: "admin_unauthorized"
          },
          403
        );
      }
      return stub.fetch(
        new Request(
          "https://q18.internal/admin/api-keys/revoke",
          request
        )
      );
    }
    if (request.method === "GET" && url.pathname.startsWith(
      "/v1/truth/"
    )) {
      return stub.fetch(
        new Request(
          "https://q18.internal" + url.pathname,
          {
            method: "GET",
            headers: request.headers
          }
        )
      );
    }
    if (request.method === "GET" && url.pathname.startsWith(
      "/v1/providers/"
    )) {
      return stub.fetch(
        new Request(
          "https://q18.internal" + url.pathname,
          request
        )
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/providers") {
      return stub.fetch(
        new Request(
          "https://q18.internal/v1/providers",
          request
        )
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/execute") {
      return stub.fetch(
        new Request(
          "https://q18.internal/v1/execute",
          request
        )
      );
    }
    if (request.method === "POST" && url.pathname === "/admin/api-keys") {
      if (!env.ONCE_ADMIN_SECRET) {
        return json(
          {
            error: "once_admin_secret_missing"
          },
          503
        );
      }
      const supplied = request.headers.get(
        "x-once-admin-secret"
      ) || "";
      if (!stripeTimingSafeHexEqual(
        supplied,
        env.ONCE_ADMIN_SECRET
      )) {
        return json(
          {
            error: "admin_unauthorized"
          },
          403
        );
      }
      return stub.fetch(
        new Request(
          "https://q18.internal/admin/api-keys",
          request
        )
      );
    }
    if (request.method === "POST" && url.pathname === "/execute" || request.method === "GET" && url.pathname.startsWith(
      "/truth/"
    )) {
      return json(
        {
          error: "not_found"
        },
        404
      );
    }
    if (request.method === "POST" && url.pathname === "/execute") {
      let legacyBody;
      try {
        legacyBody = await request.clone().json();
      } catch {
        return stub.fetch(
          new Request(
            "https://q18.internal/execute",
            request
          )
        );
      }
      legacyBody = {
        ...legacyBody,
        // Public legacy harness must never select
        // a real external provider.
        provider: "blind_test"
      };
      const legacyHeaders = new Headers(
        request.headers
      );
      legacyHeaders.delete(
        "content-length"
      );
      legacyHeaders.set(
        "content-type",
        "application/json"
      );
      return stub.fetch(
        new Request(
          "https://q18.internal/execute",
          {
            method: "POST",
            headers: legacyHeaders,
            body: JSON.stringify(
              legacyBody
            )
          }
        )
      );
    }
    if (request.method === "GET" && url.pathname.startsWith(
      "/truth/"
    )) {
      const operationId = url.pathname.substring(
        "/truth/".length
      );
      return stub.fetch(
        new Request(
          "https://q18.internal/truth/" + operationId,
          {
            method: "GET"
          }
        )
      );
    }
    return json(
      {
        error: "not_found"
      },
      404
    );
  }
};
export {
  Q18Truth,
  index_default as default
};
//# sourceMappingURL=index.js.map
