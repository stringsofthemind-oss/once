import runtime, { Q18Truth as RuntimeQ18Truth } from "./runtime-core.js";
import { handleStripeCheckout } from "./stripe-checkout.js";
import { RuntimeHostedGatewayBinding } from "./hosted-gateway-durable.mjs";
import { RuntimeHostedAdmissionPolicy } from "./hosted-admission-policy.mjs";
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

function parseProviderKeyVersion(value, name, fallback = null) {
  const raw = value === undefined || value === null || value === "" ? fallback : value;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
    throw new Error(`${name}_invalid`);
  }
  return version;
}

export class Q18Truth extends RuntimeQ18Truth {
  /**
   * Phase 12D provider-config crypto keeps the existing v1 single-key contract
   * backwards compatible while allowing one previous master key during a
   * controlled rotation window.
   *
   * Current key:
   *   ONCE_PROVIDER_MASTER_KEY
   *   ONCE_PROVIDER_MASTER_KEY_VERSION (defaults to 1)
   *
   * Optional previous key during migration:
   *   ONCE_PROVIDER_PREVIOUS_MASTER_KEY
   *   ONCE_PROVIDER_PREVIOUS_MASTER_KEY_VERSION
   *
   * New ciphertext is always written with the current version. Existing rows
   * can be decrypted only when their exact key version is configured. Unknown
   * versions fail closed; there is never a fallback that tries arbitrary keys.
   */
  getProviderMasterKeyring() {
    const currentVersion = parseProviderKeyVersion(
      this.env?.ONCE_PROVIDER_MASTER_KEY_VERSION,
      "provider_master_key_version",
      1,
    );
    const currentKey = String(this.env?.ONCE_PROVIDER_MASTER_KEY || "").trim();
    if (!currentKey) {
      throw new Error("provider_master_key_missing");
    }

    const previousKey = String(this.env?.ONCE_PROVIDER_PREVIOUS_MASTER_KEY || "").trim();
    const previousVersionRaw = String(
      this.env?.ONCE_PROVIDER_PREVIOUS_MASTER_KEY_VERSION || "",
    ).trim();

    if (Boolean(previousKey) !== Boolean(previousVersionRaw)) {
      throw new Error("provider_previous_master_key_configuration_invalid");
    }

    let previousVersion = null;
    if (previousKey) {
      previousVersion = parseProviderKeyVersion(
        previousVersionRaw,
        "provider_previous_master_key_version",
      );
      if (previousVersion === currentVersion) {
        throw new Error("provider_previous_master_key_version_conflict");
      }
    }

    return {
      currentVersion,
      currentKey,
      previousVersion,
      previousKey: previousKey || null,
    };
  }

  getProviderMasterKeyVersion() {
    return this.getProviderMasterKeyring().currentVersion;
  }

  getProviderMasterKeyBytesForVersion(keyVersion) {
    const requestedVersion = parseProviderKeyVersion(
      keyVersion,
      "provider_key_version",
    );
    const keyring = this.getProviderMasterKeyring();

    let encoded;
    if (requestedVersion === keyring.currentVersion) {
      encoded = keyring.currentKey;
    } else if (
      keyring.previousVersion !== null &&
      requestedVersion === keyring.previousVersion
    ) {
      encoded = keyring.previousKey;
    } else {
      throw new Error("provider_key_version_unsupported");
    }

    let bytes;
    try {
      bytes = this.providerBase64ToBytes(encoded);
    } catch {
      throw new Error("provider_master_key_invalid");
    }
    if (bytes.byteLength !== 32) {
      throw new Error("provider_master_key_invalid_length");
    }
    return bytes;
  }

  async getProviderCryptoKeyForVersion(keyVersion) {
    const version = parseProviderKeyVersion(keyVersion, "provider_key_version");
    if (!this._providerCryptoKeyPromisesByVersion) {
      this._providerCryptoKeyPromisesByVersion = new Map();
    }
    if (!this._providerCryptoKeyPromisesByVersion.has(version)) {
      this._providerCryptoKeyPromisesByVersion.set(
        version,
        crypto.subtle.importKey(
          "raw",
          this.getProviderMasterKeyBytesForVersion(version),
          { name: "AES-GCM" },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    }
    return this._providerCryptoKeyPromisesByVersion.get(version);
  }

  async getProviderCryptoKey() {
    return this.getProviderCryptoKeyForVersion(this.getProviderMasterKeyVersion());
  }

  async encryptProviderConfig(customerId, providerName, versionId, config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("provider_config_invalid");
    }

    const keyVersion = this.getProviderMasterKeyVersion();
    const key = await this.getProviderCryptoKeyForVersion(keyVersion);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(config));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: this.providerConfigAad(customerId, providerName, versionId),
        tagLength: 128,
      },
      key,
      plaintext,
    );

    return {
      encryptedConfig: this.providerBytesToBase64(new Uint8Array(encrypted)),
      ivB64: this.providerBytesToBase64(iv),
      keyVersion,
    };
  }

  async decryptProviderConfig(
    customerId,
    providerName,
    versionId,
    encryptedConfig,
    ivB64,
    keyVersion = 1,
  ) {
    const version = parseProviderKeyVersion(keyVersion, "provider_key_version");
    const key = await this.getProviderCryptoKeyForVersion(version);
    const iv = this.providerBase64ToBytes(ivB64);
    if (iv.byteLength !== 12) {
      throw new Error("provider_config_iv_invalid");
    }

    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: this.providerConfigAad(customerId, providerName, versionId),
          tagLength: 128,
        },
        key,
        this.providerBase64ToBytes(encryptedConfig),
      );
    } catch {
      throw new Error("provider_config_decryption_failed");
    }

    let config;
    try {
      config = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new Error("provider_config_plaintext_invalid");
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("provider_config_plaintext_invalid");
    }
    return config;
  }

  getHostedProviderCredentialStore() {
    if (!this._hostedProviderCredentialStore) {
      this._hostedProviderCredentialStore = new RuntimeHostedProviderCredentialStore({
        ctx: this.ctx,
        encryptConfig: (...args) => this.encryptProviderConfig(...args),
        decryptConfig: (...args) => this.decryptProviderConfig(...args),
        currentKeyVersion: () => this.getProviderMasterKeyVersion(),
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
      this._hostedAdmissionPolicy = new RuntimeHostedAdmissionPolicy({ ctx: this.ctx });
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
    // through the staging bridge or future reviewed hosted transport.
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
