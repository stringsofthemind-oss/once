import { promises as fs } from "node:fs";
import path from "node:path";

import {
  inspectProtectionReceipt
} from "./protection-receipt.js";

type ProtectPlanCandidate = {
  auto_apply_eligible?: boolean;
};

type ProtectPlan = {
  candidates?: ProtectPlanCandidate[];
};

export type AdoptionMetrics = {
  consequential_candidates: number;
  auto_apply_eligible: number;
  autoprotection_rate_percent: number;
  verified_protected: number;
  verified_protection_rate_percent: number;
  time_to_protected_ms: number | null;
};

async function readProtectPlan(
  root: string
): Promise<ProtectPlan | null> {
  try {
    const raw = await fs.readFile(
      path.join(root, ".once", "protect-plan.json"),
      "utf8"
    );

    return JSON.parse(raw.replace(/^\uFEFF/, "")) as ProtectPlan;
  } catch {
    return null;
  }
}

function percent(
  numerator: number,
  denominator: number
): number {
  if (denominator === 0) {
    return 0;
  }

  return Number(
    ((numerator / denominator) * 100).toFixed(1)
  );
}

export async function measureAdoptionMetrics(
  requestedPath: string,
  elapsedMs: number
): Promise<AdoptionMetrics> {
  const root = path.resolve(requestedPath);
  const plan = await readProtectPlan(root);
  const candidates = Array.isArray(plan?.candidates)
    ? plan.candidates
    : [];

  const consequentialCandidates = candidates.length;
  const autoApplyEligible = candidates.filter(
    candidate => candidate.auto_apply_eligible === true
  ).length;

  const receipt = await inspectProtectionReceipt(root);
  const verifiedProtected =
    receipt?.state === "CURRENT_PROTECTED"
      ? 1
      : 0;

  return {
    consequential_candidates: consequentialCandidates,
    auto_apply_eligible: autoApplyEligible,
    autoprotection_rate_percent: percent(
      autoApplyEligible,
      consequentialCandidates
    ),
    verified_protected: verifiedProtected,
    verified_protection_rate_percent: percent(
      verifiedProtected,
      consequentialCandidates
    ),
    time_to_protected_ms:
      verifiedProtected > 0
        ? Math.max(0, Math.round(elapsedMs))
        : null
  };
}

export function printAdoptionMetrics(
  metrics: AdoptionMetrics
): void {
  console.log("");
  console.log("AUTOPROTECTION METRICS");
  console.log("----------------------");
  console.log(
    `Consequential candidates: ${metrics.consequential_candidates}`
  );
  console.log(
    `Automatically applicable: ${metrics.auto_apply_eligible}`
  );
  console.log(
    `Autoprotection Rate: ${metrics.autoprotection_rate_percent.toFixed(1)}%`
  );
  console.log(
    `Verified protected: ${metrics.verified_protected}`
  );
  console.log(
    `Verified Protection Rate: ${metrics.verified_protection_rate_percent.toFixed(1)}%`
  );
  console.log(
    metrics.time_to_protected_ms === null
      ? "Time-to-Protected: not yet achieved"
      : `Time-to-Protected: ${metrics.time_to_protected_ms} ms`
  );
  console.log(
    "Metrics are computed locally from the protection plan and current route-proof receipt; no telemetry is sent."
  );
}