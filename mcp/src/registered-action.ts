import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { canonicalizeConnectPayload, LocalProtectionError, protectToolCall } from "@once-agent/sdk";
import { createLocalProtectionSession, withLocalProtectionSession } from "@once-agent/sdk/connect";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const authoritySchema = z.strictObject({
  provider: z.literal("disposable-orders"), accountId: identifier, environment: z.literal("local-test"),
});
const orderSchema = z.strictObject({
  sku: z.enum(["SKU-1", "SKU-2"]), quantity: z.number().int().min(1).max(10), destinationId: z.enum(["address-1", "address-2"]),
});
const inputSchema = z.strictObject({ operationId: identifier, args: orderSchema });
const effectSchema = z.strictObject({
  contract: z.literal("once-registered-order-v1"), action: identifier,
  authority: authoritySchema, resourceId: identifier, providerArgs: orderSchema,
});
const receiptSchema = z.strictObject({
  providerReference: identifier, status: z.literal("created"), operationId: identifier, effect: effectSchema,
});
const confirmationSchema = z.strictObject({
  status: z.literal("CONFIRMED"), authoritative: z.literal(true), complete: z.literal(true),
  observedAt: z.number().int(), receipt: receiptSchema,
});

export type OrderAuthority = z.infer<typeof authoritySchema>;
export type PreparedOrderEffect = z.infer<typeof effectSchema>;
export type OrderReceipt = z.infer<typeof receiptSchema>;

/** Trusted host capability. This is never supplied through tools/call.
 * create must perform one unary write with no hidden retries. lookup must only
 * read authoritative provider records in this client's authenticated account.
 */
export interface RegisteredOrderProvider {
  assertAuthority(): Promise<unknown>;
  create(effect: Readonly<PreparedOrderEffect>, operationId: string): Promise<unknown>;
  lookup(operationId: string): Promise<unknown>;
}

export interface RegisteredOrderOptions {
  /** Host-selected alias, fixed for the lifetime of this registration. */
  name?: string;
  authority: OrderAuthority;
  resourceId: string;
  /** Existing, host-provisioned persistent ledger. Never initialized here. */
  statePath: string;
  provider: RegisteredOrderProvider;
  /** Host admission/receipt-access check; required even for confirmed replay. */
  authorize(context: unknown): Promise<void>;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function same(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonicalizeConnectPayload(a) === canonicalizeConnectPayload(b);
}

/** Opt-in registration of ONE reviewed local-test order action. No dispatcher,
 * URL/command/module loading, new ledger or execution state machine is added.
 * The host must await registration before connecting the server, and close the
 * returned session after stopping it. Node 24.15+; same-machine authority only.
 */
export async function registerProtectedOrderAction(server: McpServer, options: RegisteredOrderOptions) {
  const name = identifier.parse(options.name ?? "once_create_order");
  const authority = freeze(authoritySchema.parse(options.authority));
  const resourceId = identifier.parse(options.resourceId);
  if (!isAbsolute(options.statePath) || !options.provider ||
      typeof options.authorize !== "function" ||
      ["assertAuthority", "create", "lookup"].some(key => typeof options.provider[key as keyof RegisteredOrderProvider] !== "function")) {
    throw new LocalProtectionError("UNSUPPORTED_BOUNDARY", "A fixed host capability, admission check and absolute persistent ledger are required.");
  }
  // Capture the reviewed capability and methods; later options mutation cannot
  // replace them. A mutable client's principal must be checked by its host.
  const provider = options.provider;
  const assertAuthority = provider.assertAuthority.bind(provider);
  const create = provider.create.bind(provider);
  const lookup = provider.lookup.bind(provider);
  const authorize = options.authorize;
  const statePath = options.statePath;
  const checkAuthority = async () => {
    const observed = authoritySchema.safeParse(await assertAuthority());
    if (!observed.success || !same(observed.data, authority)) {
      throw new LocalProtectionError("UNSUPPORTED_BOUNDARY", "Authenticated provider authority no longer matches the registered action.");
    }
  };
  let initialIdentity;
  try {
    initialIdentity = statSync(statePath, { bigint: true });
    if (!initialIdentity.isFile() || initialIdentity.size === 0n) throw Error("not an initialized ledger file");
  } catch {
    throw new LocalProtectionError("STATE_UNAVAILABLE", "Restore the original host-provisioned ledger before registering this action.");
  }
  const session = createLocalProtectionSession(statePath);
  try {
    await session.databaseForCall();
    const currentIdentity = statSync(statePath, { bigint: true });
    if (currentIdentity.dev !== initialIdentity.dev || currentIdentity.ino !== initialIdentity.ino ||
        currentIdentity.birthtimeNs !== initialIdentity.birthtimeNs) {
      throw new LocalProtectionError("STATE_UNAVAILABLE", "The host ledger changed during registration; no provider dispatch is permitted.");
    }
    await checkAuthority();
  } catch (error) {
    session.close();
    throw error;
  }
  const validateReceipt = (raw: unknown, operationId: string, effect: PreparedOrderEffect): OrderReceipt => {
    const receipt = receiptSchema.parse(raw);
    if (receipt.operationId !== operationId || !same(receipt.effect, effect)) {
      throw Error("Provider receipt does not match the complete prepared operation.");
    }
    return receipt;
  };
  try {
    server.registerTool(name, {
      description: "Create one disposable local-test order through Once. Persist operationId before calling; reuse it on retries/handoffs. UNKNOWN never permits redispatch. Only this registered action is supported.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async (input, context) => {
      try {
        await authorize(context);
        await checkAuthority();
        const effect = freeze(effectSchema.parse({
          contract: "once-registered-order-v1", action: name, authority, resourceId, providerArgs: input.args,
        }));
        const result = await withLocalProtectionSession(session, () => protectToolCall({
          operationId: input.operationId,
          statePath,
          effect: { tool: name, args: effect },
          execute: async ({ args }) => {
            await checkAuthority();
            // Identity is separate from provider arguments; this reviewed client
            // maps it to the provider's durable lookup reference.
            const receipt = await create(args, input.operationId);
            await checkAuthority();
            return validateReceipt(receipt, input.operationId, args);
          },
          reconcile: async ({ operationId, effect: prepared }) => {
            await checkAuthority();
            const observation = confirmationSchema.safeParse(await lookup(operationId));
            await checkAuthority();
            if (!observation.success || observation.data.observedAt > Date.now() ||
                Date.now() - observation.data.observedAt > 30_000) return { status: "UNKNOWN" };
            try {
              return { status: "CONFIRMED", result: validateReceipt(observation.data.receipt, operationId, prepared.args) };
            } catch { return { status: "UNKNOWN" }; }
            // ABSENT, incomplete, stale, mismatched and malformed evidence all
            // remain UNKNOWN. The existing local primitive never redispatches.
          },
        }));
        const output = { operationId: input.operationId, status: "CONFIRMED", result };
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        const code = error instanceof LocalProtectionError ? error.code : "UNSUPPORTED_BOUNDARY";
        const output = { operationId: input.operationId, status: code, code, retryAllowed: false };
        // No raw exception, provider response, credential, or transport metadata
        // is returned. Semantic provider failure is UNKNOWN in protectToolCall.
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
      }
    });
  } catch (error) {
    session.close();
    throw error;
  }
  return { close: () => session.close() };
}
