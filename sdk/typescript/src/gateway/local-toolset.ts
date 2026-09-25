import {
  connectLocalAgentToolsetAuto,
  type AutoLocalAgentToolsetOptions,
  type ConnectedLocalAgentToolRegistry,
  type LocalAgentToolRegistry,
} from "../connect/toolset.js";
import {
  GATEWAY_ROUTE,
  planGatewayToolset,
  type GatewayPlan,
} from "./planner.js";

export type LocalGatewayToolsetOptions = AutoLocalAgentToolsetOptions;

export interface ConnectedLocalGatewayToolset<
  T extends LocalAgentToolRegistry,
> {
  /** Frozen gateway route plan for exactly the supplied runtime-selected subset. */
  plan: Readonly<GatewayPlan>;
  /** Frozen registry. Expose this registry to the runtime instead of the originals. */
  tools: Readonly<ConnectedLocalAgentToolRegistry<T>>;
}

export class GatewayConnectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GatewayConnectionError";
  }
}

function blockedSummary(plan: Readonly<GatewayPlan>): string {
  return plan.blocked
    .map(entry => `${entry.name ?? `#${entry.index}`}:${entry.connectReason}`)
    .join(", ");
}

function verifyConnectAgreement(
  gatewayPlan: Readonly<GatewayPlan>,
  connectPlan: Readonly<{
    entries: readonly Readonly<{
      decision: string;
    }>[];
  }>,
): void {
  if (gatewayPlan.entries.length !== connectPlan.entries.length) {
    throw new GatewayConnectionError(
      "GATEWAY_PLAN_MISMATCH",
      "Gateway and Connect disagree about the selected toolset length.",
    );
  }

  for (let index = 0; index < gatewayPlan.entries.length; index += 1) {
    const gateway = gatewayPlan.entries[index];
    const connect = connectPlan.entries[index];
    const expected = gateway.route === GATEWAY_ROUTE.DIRECT
      ? "BYPASS"
      : gateway.route === GATEWAY_ROUTE.PROTECT
        ? "PROTECT"
        : "UNKNOWN";

    if (connect.decision !== expected) {
      throw new GatewayConnectionError(
        "GATEWAY_PLAN_MISMATCH",
        `Gateway and Connect disagree about route index ${index}.`,
      );
    }
  }
}

/**
 * Wire a complete runtime-selected local tool subset through the Once Gateway.
 *
 * This function intentionally contains no execution engine. It performs a
 * gateway preflight, then delegates all registry validation and wrapper
 * creation to the existing Connect toolset path.
 *
 * A selected subset containing BLOCK cannot be partially wired. Returning a
 * mixed registry would leave an unprotected bypass surface for unresolved
 * tools, so v1 fails the whole selected subset closed.
 */
export function connectLocalGatewayToolsetAuto<
  T extends LocalAgentToolRegistry,
>(
  tools: T,
  options: LocalGatewayToolsetOptions,
): Readonly<ConnectedLocalGatewayToolset<T>> {
  if (!options || !("manifest" in options)) {
    throw new GatewayConnectionError(
      "INVALID_GATEWAY_MANIFEST",
      "Once Gateway needs the complete runtime-selected tool manifest before wiring.",
    );
  }

  const plan = planGatewayToolset(options.manifest);

  if (!plan.valid) {
    throw new GatewayConnectionError(
      "INVALID_GATEWAY_MANIFEST",
      "Once Gateway could not parse the supplied runtime-selected tool manifest.",
    );
  }

  if (!plan.ready) {
    throw new GatewayConnectionError(
      "GATEWAY_BLOCKED",
      `Once Gateway refuses partial wiring while selected-tool routing is unresolved: ${blockedSummary(plan)}.`,
    );
  }

  const connected = connectLocalAgentToolsetAuto(tools, options);
  verifyConnectAgreement(plan, connected.plan);

  return Object.freeze({
    plan,
    tools: connected.tools,
  });
}
