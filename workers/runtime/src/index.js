import runtime, { Q18Truth as RuntimeQ18Truth } from "./runtime-core.js";
import { handleStripeCheckout } from "./stripe-checkout.js";
import { RuntimeHostedGatewayBinding } from "./hosted-gateway-durable.mjs";
import { createRuntimeHostedAdmissionPolicy } from "./hosted-entitlement-freshness.mjs";
import { RuntimeHostedProviderCredentialStore } from "./hosted-provider-credentials.mjs";
import { RuntimeHostedProviderKeyring } from "./hosted-provider-keyring.mjs";
import {
  HttpResponseReplayV2Store,
  validateHttpResponseReplayV2ForPersistence,
} from "./http-response-replay-v2-persistence.mjs";
import {
  handleHostedCredentialInternalRequest,
  handleStagingHostedCredentialAdminRequest,
  INTERNAL_HOSTED_CREDENTIAL_ADMIN_HOST,
  INTERNAL_HOSTED_CREDENTIAL_ADMIN_PATH,
  STAGING_HOSTED_CREDENTIAL_ADMIN_PATH,
} from "./hosted-credential-admin.mjs";
import {
  handleHostedGatewayInternalRequest,
  INTERNAL_HOSTED_EXECUTE_HOST,
  INTERNAL_HOSTED_EXECUTE_PATH,
} from "./hosted-gateway-transport.mjs";
import {
  maybeHandlePublicHostedGatewayRequest,
  PUBLIC_HOSTED_EXECUTE_PATH,
} from "./hosted-public-execute.mjs";
import {
  handleStagingHostedGatewayRequest,
  STAGING_HOSTED_EXECUTE_PATH,
} from "./hosted-staging-execute.mjs";
import {
  handleHostedTenantInternalRequest,
  handleStagingHostedTenantAdminRequest,
  INTERNAL_HOSTED_TENANT_ADMIN_HOST,
  INTERNAL_HOSTED_TENANT_ADMIN_PATH,
  STAGING_HOSTED_TENANT_ADMIN_PATH,
} from "./hosted-staging-tenant-admin.mjs";
import { createStagingStripeFetch } from "./hosted-staging-stripe-fault.mjs";
import { createHostedStripeRefundResolver } from "./hosted-stripe-refund-registration.mjs";
import {
  handleHostedStripeEntitlementEvent,
  maybeHandleHostedStripeEntitlementWebhook,
  INTERNAL_HOSTED_ENTITLEMENT_EVENT_HOST,
  INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH,
} from "./hosted-stripe-entitlement-ordering.mjs";

const PUBLIC_STATS_PATH = "/v1/public/stats";
const STRIPE_CHECKOUT_PATH = "/v1/billing/checkout";
const INTERNAL_STATS_PATH = "/__once/public/stats";
const LEDGER_NAME = "once-q18-authoritative-ledger-v1";
const MAX_PENDING_REPLAY_V2 = 128;

function publicStatsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Accept",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "cross-origin",
    ...extra,
  };
}

function publicStatsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: publicStatsHeaders(),
  });
}

function replayOperationKey(operationId) {
  return String(operationId || "").trim();
}

export class Q18Truth extends RuntimeQ18Truth {
  constructor(ctx, env) {
    super(ctx, env);
    this.httpResponseReplayV2Store = new HttpResponseReplayV2Store(
      this.ctx.storage.sql,
    );
    this.pendingHttpResponseReplayV2 = new Map();
  }

  async executeProvider(providerName, operationId, action = {}) {
    const key = replayOperationKey(operationId);
    if (key) this.pendingHttpResponseReplayV2.delete(key);

    const provider = await super.executeProvider(providerName, operationId, action);
    const candidate = provider?.http_response?.replay_v2;

    if (key && candidate !== undefined) {
      try {
        const validated = validateHttpResponseReplayV2ForPersistence(candidate);

        if (
          !this.pendingHttpResponseReplayV2.has(key) &&
          this.pendingHttpResponseReplayV2.size >= MAX_PENDING_REPLAY_V2
        ) {
          const oldest = this.pendingHttpResponseReplayV2.keys().next().value;
          if (oldest !== undefined) this.pendingHttpResponseReplayV2.delete(oldest);
        }

        this.pendingHttpResponseReplayV2.set(key, validated);
      } catch {
        // v2 is optional capability evidence in this slice. Invalid metadata
        // cannot alter established v1 confirmation semantics, and no durable
        // v2 row means later native Response capability remains unavailable.
      }
    }

    return provider;
  }

  recordHttpResponseReplay(operationId, options = {}) {
    const key = replayOperationKey(operationId);

    try {
      // Base v1 replay validation and conflict behavior remain authoritative.
      // Its caller already wraps this write and CONFIRMED transition in one
      // Durable Object SQL transaction; the v2 row joins that same transaction.
      const replayV1 = super.recordHttpResponseReplay(operationId, options);
      const replayV2 = key ? this.pendingHttpResponseReplayV2.get(key) : undefined;

      if (replayV2) {
        this.httpResponseReplayV2Store.record(key, replayV2, {
          recordedAt: options.recordedAt,
        });
      }

      return replayV1;
    } finally {
      if (key) this.pendingHttpResponseReplayV2.delete(key);
    }
  }

  getHttpResponseReplayV2(operationId) {
    return this.httpResponseReplayV2Store.get(operationId);
  }

  getHostedProviderKeyring() {
    if (!this._hostedProviderKeyring) {
      this._hostedProviderKeyring = new RuntimeHostedProviderKeyring({
        env: this.env || {},
        bytesToBase64: (bytes) => this.providerBytesToBase64(bytes),
        base64ToBytes: (value) => this.providerBase64ToBytes(value),
        aadFor: (customerId, providerName, versionId) =>
          this.providerConfigAad(customerId, providerName, versionId),
      });
    }
    return this._hostedProviderKeyring;
  }

  getHostedProviderCredentialStore() {
    if (!this._hostedProviderCredentialStore) {
      const keyring = this.getHostedProviderKeyring();
      this._hostedProviderCredentialStore = new RuntimeHostedProviderCredentialStore({
        ctx: this.ctx,
        encryptConfig: (...args) => keyring.encryptConfig(...args),
        decryptConfig: (...args) => keyring.decryptConfig(...args),
        currentKeyVersion: () => keyring.getCurrentKeyVersion(),
      });
    }
    return this._hostedProviderCredentialStore;
  }

  /**
   * Hosted Stripe credentials resolve only from the authenticated tenant's
   * encrypted provider credential record. There is deliberately no global
   * environment-secret fallback on this path.
   */
  async getHostedStripeRefundSecret({ tenantId }) {
    return this.getHostedProviderCredentialStore().getStripeRefundSecret({ tenantId });
  }

  getHostedStripeFetch() {
    if (!this._hostedStripeFetch) {
      this._hostedStripeFetch = createStagingStripeFetch({ env: this.env, fetchImpl: fetch });
    }
    return this._hostedStripeFetch;
  }

  getHostedStripeRefundResolver() {
    if (!this._hostedStripeRefundResolver) {
      this._hostedStripeRefundResolver = createHostedStripeRefundResolver({
        getSecretKey: (context) => this.getHostedStripeRefundSecret(context),
        fetchImpl: (...args) => this.getHostedStripeFetch()(...args),
      });
    }
    return this._hostedStripeRefundResolver;
  }

  async resolveHostedGatewayRegistration(context) {
    return this.getHostedStripeRefundResolver()(context);
  }

  getHostedAdmissionPolicy() {
    // Phase 12D is opt-in while under review. Existing Phase 12C staging/proof
    // behavior remains unchanged unless this exact non-production gate is set.
    if (String(this.env?.ONCE_HOSTED_ADMISSION_ENABLED || "") !== "phase12d") {
      return null;
    }
    if (!this._hostedAdmissionPolicy) {
      this._hostedAdmissionPolicy = createRuntimeHostedAdmissionPolicy({
        ctx: this.ctx,
        env: this.env || {},
      });
    }
    return this._hostedAdmissionPolicy;
  }

  getHostedGatewayBinding() {
    if (!this._hostedGatewayBinding) {
      this._hostedGatewayBinding = new RuntimeHostedGatewayBinding({
        ctx: this.ctx,
        resolveRegistration: (context) => this.resolveHostedGatewayRegistration(context),
        admissionPolicy: this.getHostedAdmissionPolicy(),
      });
    }
    return this._hostedGatewayBinding;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (
      url.hostname === INTERNAL_HOSTED_ENTITLEMENT_EVENT_HOST &&
      url.pathname === INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH
    ) {
      return handleHostedStripeEntitlementEvent({
        request,
        ctx: this.ctx,
      });
    }

    if (
      url.hostname === INTERNAL_HOSTED_CREDENTIAL_ADMIN_HOST &&
      url.pathname === INTERNAL_HOSTED_CREDENTIAL_ADMIN_PATH
    ) {
      const credentialStore = this.getHostedProviderCredentialStore();
      return handleHostedCredentialInternalRequest({
        request,
        credentialStore,
        tenantExists: (tenantId) => credentialStore.hasActiveTenant(tenantId),
      });
    }

    if (
      url.hostname === INTERNAL_HOSTED_TENANT_ADMIN_HOST &&
      url.pathname === INTERNAL_HOSTED_TENANT_ADMIN_PATH
    ) {
      return handleHostedTenantInternalRequest({ request, ctx: this.ctx });
    }

    // Deliberately internal-only: the outer Worker reaches this route only
    // through the staging bridge or a separately enabled public preview bridge.
    if (
      url.hostname === INTERNAL_HOSTED_EXECUTE_HOST &&
      url.pathname === INTERNAL_HOSTED_EXECUTE_PATH
    ) {
      return handleHostedGatewayInternalRequest({
        request,
        binding: this.getHostedGatewayBinding(),
      });
    }

    if (request.method === "GET" && url.pathname === INTERNAL_STATS_PATH) {
      const row = [
        ...this.ctx.storage.sql.exec(`
          SELECT COUNT(*) AS protected_operations
          FROM operations
        `),
      ][0];

      const protectedOperations = Number(row?.protected_operations ?? 0);

      if (!Number.isSafeInteger(protectedOperations) || protectedOperations < 0) {
        return publicStatsJson({ error: "stats_invalid" }, 500);
      }

      return publicStatsJson({
        protected_operations: protectedOperations,
        source: "once_runtime_ledger",
      });
    }

    return super.fetch(request);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const orderedEntitlementWebhook = await maybeHandleHostedStripeEntitlementWebhook({
      request,
      env,
      getDurableStub: async () => {
        const id = env.Q18_TRUTH.idFromName(LEDGER_NAME);
        return env.Q18_TRUTH.get(id);
      },
    });
    if (orderedEntitlementWebhook !== null) return orderedEntitlementWebhook;

    if (url.pathname === PUBLIC_HOSTED_EXECUTE_PATH) {
      const hostedResponse = await maybeHandlePublicHostedGatewayRequest({
        request,
        env,
        getDurableStub: async () => {
          const id = env.Q18_TRUTH.idFromName(LEDGER_NAME);
          return env.Q18_TRUTH.get(id);
        },
      });
      if (hostedResponse !== null) return hostedResponse;
      // Gate absent: deliberately fall through to the existing runtime's
      // /v1/execute behavior. Merge alone is therefore not a cutover.
    }

    if (url.pathname === STAGING_HOSTED_CREDENTIAL_ADMIN_PATH) {
      return handleStagingHostedCredentialAdminRequest({
        request,
        env,
        getDurableStub: async () => {
          const id = env.Q18_TRUTH.idFromName(LEDGER_NAME);
          return env.Q18_TRUTH.get(id);
        },
      });
    }

    if (url.pathname === STAGING_HOSTED_TENANT_ADMIN_PATH) {
      return handleStagingHostedTenantAdminRequest({
        request,
        env,
        getDurableStub: async () => {
          const id = env.Q18_TRUTH.idFromName(LEDGER_NAME);
          return env.Q18_TRUTH.get(id);
        },
      });
    }

    if (url.pathname === STAGING_HOSTED_EXECUTE_PATH) {
      return handleStagingHostedGatewayRequest({
        request,
        env,
        getDurableStub: async () => {
          const id = env.Q18_TRUTH.idFromName(LEDGER_NAME);
          return env.Q18_TRUTH.get(id);
        },
      });
    }

    if (url.pathname === STRIPE_CHECKOUT_PATH) {
      return handleStripeCheckout(request, env);
    }

    if (url.pathname === PUBLIC_STATS_PATH) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: publicStatsHeaders({
            "content-type": "text/plain; charset=utf-8",
          }),
        });
      }

      if (request.method !== "GET") {
        return publicStatsJson({ error: "method_not_allowed" }, 405);
      }

      try {
        const id = env.Q18_TRUTH.idFromName(LEDGER_NAME);
        const stub = env.Q18_TRUTH.get(id);
        const internal = await stub.fetch(
          new Request(`https://q18.internal${INTERNAL_STATS_PATH}`, {
            method: "GET",
          }),
        );

        if (!internal.ok) {
          return publicStatsJson({ error: "stats_unavailable" }, 503);
        }

        const data = await internal.json();
        const protectedOperations = Number(data?.protected_operations);

        if (!Number.isSafeInteger(protectedOperations) || protectedOperations < 0) {
          return publicStatsJson({ error: "stats_invalid" }, 503);
        }

        return publicStatsJson({
          protected_operations: protectedOperations,
          source: "once_runtime_ledger",
        });
      } catch {
        return publicStatsJson({ error: "stats_unavailable" }, 503);
      }
    }

    return runtime.fetch(request, env, ctx);
  },
};
