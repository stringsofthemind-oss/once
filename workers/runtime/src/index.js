import runtime, { Q18Truth as RuntimeQ18Truth } from "./runtime-core.js";
import { handleStripeCheckout } from "./stripe-checkout.js";
import { RuntimeHostedGatewayBinding } from "./hosted-gateway-durable.mjs";
import { RuntimeHostedProviderCredentialStore } from "./hosted-provider-credentials.mjs";
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
import { createHostedStripeRefundResolver } from "./hosted-stripe-refund-registration.mjs";

const PUBLIC_STATS_PATH = "/v1/public/stats";
const STRIPE_CHECKOUT_PATH = "/v1/billing/checkout";
const INTERNAL_STATS_PATH = "/__once/public/stats";
const LEDGER_NAME = "once-q18-authoritative-ledger-v1";

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

export class Q18Truth extends RuntimeQ18Truth {
  getHostedProviderCredentialStore() {
    if (!this._hostedProviderCredentialStore) {
      this._hostedProviderCredentialStore = new RuntimeHostedProviderCredentialStore({
        ctx: this.ctx,
        encryptConfig: (...args) => this.encryptProviderConfig(...args),
        decryptConfig: (...args) => this.decryptProviderConfig(...args),
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

  hasActiveHostedTenant(tenantId) {
    const row = [
      ...this.ctx.storage.sql.exec(
        `
          SELECT 1 AS present
          FROM api_keys
          WHERE customer_id = ? AND revoked_at IS NULL
          LIMIT 1
        `,
        String(tenantId),
      ),
    ][0];
    return Boolean(row?.present);
  }

  getHostedStripeFetch() {
    return fetch;
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

  getHostedGatewayBinding() {
    if (!this._hostedGatewayBinding) {
      this._hostedGatewayBinding = new RuntimeHostedGatewayBinding({
        ctx: this.ctx,
        resolveRegistration: (context) => this.resolveHostedGatewayRegistration(context),
      });
    }
    return this._hostedGatewayBinding;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (
      url.hostname === INTERNAL_HOSTED_CREDENTIAL_ADMIN_HOST &&
      url.pathname === INTERNAL_HOSTED_CREDENTIAL_ADMIN_PATH
    ) {
      return handleHostedCredentialInternalRequest({
        request,
        credentialStore: this.getHostedProviderCredentialStore(),
        tenantExists: (tenantId) => this.hasActiveHostedTenant(tenantId),
      });
    }

    // Deliberately internal-only: the outer Worker does not expose this route,
    // and the Durable Object accepts it only on the synthetic q18.internal host.
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
