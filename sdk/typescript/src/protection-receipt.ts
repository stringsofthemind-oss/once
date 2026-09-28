import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const PROTECTION_RECEIPT_FILE =
  "protection-status.json" as const;

export const ONCE_SDK_EXECUTE_ROUTE =
  "ONCE_SDK_EXECUTE_V1" as const;

export const ONCE_EXECUTE_LOST_ACK_PROOF =
  "ONCE_EXECUTE_LOST_ACK_REPLAY_V1" as const;

type ProtectionReceiptBase = Readonly<{
  schema_version: 1;
  applied_at: string;
  callsite_ref: string;
  file: string;
  provider: string;
  transformer_id: "ts_fetch_post_void_v1";
  source_sha256: string;
  applied_sha256: string;
  execution_route: typeof ONCE_SDK_EXECUTE_ROUTE;
}>;

export type PendingProtectionReceipt = ProtectionReceiptBase & Readonly<{
  status: "APPLIED_PENDING_ROUTE_PROOF";
  once_protected: false;
  route_proof: Readonly<{
    required: typeof ONCE_EXECUTE_LOST_ACK_PROOF;
    state: "PENDING";
    verified_at: null;
  }>;
}>;

export type VerifiedProtectionReceipt = ProtectionReceiptBase & Readonly<{
  status: "PROTECTED";
  once_protected: true;
  route_proof: Readonly<{
    required: typeof ONCE_EXECUTE_LOST_ACK_PROOF;
    state: "PASS";
    verified_at: string;
    operation_id: string;
    attempts: number;
    side_effects: 1;
  }>;
}>;

export type ProtectionReceipt =
  | PendingProtectionReceipt
  | VerifiedProtectionReceipt;

export type ProtectionReceiptInspection =
  | Readonly<{
      state: "CURRENT_PENDING_PROOF";
      receipt: PendingProtectionReceipt;
    }>
  | Readonly<{
      state: "CURRENT_PROTECTED";
      receipt: VerifiedProtectionReceipt;
    }>
  | Readonly<{
      state: "STALE_SOURCE";
      receipt: ProtectionReceipt;
      detail: string;
    }>
  | Readonly<{
      state: "INVALID_RECEIPT";
      detail: string;
    }>;

export interface WriteProtectionReceiptInput {
  callsiteRef: string;
  file: string;
  provider: string;
  sourceSha256: string;
  appliedSha256: string;
}

export interface VerifiedRouteProofInput {
  operationId: string;
  attempts: number;
  sideEffects: number;
}

function sha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

function receiptPath(root: string): string {
  return path.join(root, ".once", PROTECTION_RECEIPT_FILE);
}

function hasBaseReceiptShape(
  receipt: Record<string, unknown>
): boolean {
  return (
    receipt.schema_version === 1 &&
    typeof receipt.applied_at === "string" &&
    typeof receipt.callsite_ref === "string" &&
    typeof receipt.file === "string" &&
    typeof receipt.provider === "string" &&
    receipt.transformer_id === "ts_fetch_post_void_v1" &&
    typeof receipt.source_sha256 === "string" &&
    typeof receipt.applied_sha256 === "string" &&
    receipt.execution_route === ONCE_SDK_EXECUTE_ROUTE
  );
}

function isProtectionReceipt(value: unknown): value is ProtectionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const receipt = value as Record<string, unknown>;
  const routeProof = receipt.route_proof as Record<string, unknown> | undefined;

  if (
    !hasBaseReceiptShape(receipt) ||
    !routeProof ||
    routeProof.required !== ONCE_EXECUTE_LOST_ACK_PROOF
  ) {
    return false;
  }

  if (
    receipt.status === "APPLIED_PENDING_ROUTE_PROOF" &&
    receipt.once_protected === false
  ) {
    return (
      routeProof.state === "PENDING" &&
      routeProof.verified_at === null
    );
  }

  if (
    receipt.status === "PROTECTED" &&
    receipt.once_protected === true
  ) {
    return (
      routeProof.state === "PASS" &&
      typeof routeProof.verified_at === "string" &&
      typeof routeProof.operation_id === "string" &&
      Number.isSafeInteger(routeProof.attempts) &&
      Number(routeProof.attempts) >= 2 &&
      routeProof.side_effects === 1
    );
  }

  return false;
}

async function persistReceipt(
  root: string,
  receipt: ProtectionReceipt,
): Promise<string> {
  const onceDirectory = path.join(root, ".once");
  const target = receiptPath(root);
  const temporary = path.join(
    onceDirectory,
    `.once-protection-status-${process.pid}-${Date.now()}.tmp`,
  );

  await fs.mkdir(onceDirectory, { recursive: true });

  try {
    await fs.writeFile(
      temporary,
      JSON.stringify(receipt, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" },
    );

    // Windows does not reliably replace an existing target with rename().
    // Removing the old receipt first is safe because this metadata never grants
    // execution authority. A missing receipt means no protection claim.
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }

  return target;
}

export async function writeProtectionReceipt(
  requestedPath: string,
  input: WriteProtectionReceiptInput,
): Promise<{ path: string; receipt: PendingProtectionReceipt }> {
  const root = path.resolve(requestedPath);

  const receipt: PendingProtectionReceipt = Object.freeze({
    schema_version: 1,
    status: "APPLIED_PENDING_ROUTE_PROOF",
    once_protected: false,
    applied_at: new Date().toISOString(),
    callsite_ref: input.callsiteRef,
    file: input.file,
    provider: input.provider,
    transformer_id: "ts_fetch_post_void_v1",
    source_sha256: input.sourceSha256,
    applied_sha256: input.appliedSha256,
    execution_route: ONCE_SDK_EXECUTE_ROUTE,
    route_proof: Object.freeze({
      required: ONCE_EXECUTE_LOST_ACK_PROOF,
      state: "PENDING",
      verified_at: null,
    }),
  });

  const target = await persistReceipt(root, receipt);
  return { path: target, receipt };
}

export async function inspectProtectionReceipt(
  requestedPath: string,
): Promise<ProtectionReceiptInspection | null> {
  const root = path.resolve(requestedPath);
  const target = receiptPath(root);

  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return {
      state: "INVALID_RECEIPT",
      detail: "Protection receipt is not valid JSON.",
    };
  }

  if (!isProtectionReceipt(parsed)) {
    return {
      state: "INVALID_RECEIPT",
      detail: "Protection receipt does not satisfy the supported schema.",
    };
  }

  const sourcePath = path.resolve(root, parsed.file);
  const relative = path.relative(root, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      state: "INVALID_RECEIPT",
      detail: "Protection receipt source path escapes the project root.",
    };
  }

  let source: string;
  try {
    source = await fs.readFile(sourcePath, "utf8");
  } catch {
    return {
      state: "STALE_SOURCE",
      receipt: parsed,
      detail: "The protected source file is no longer readable at the recorded path.",
    };
  }

  if (sha256(source) !== parsed.applied_sha256) {
    return {
      state: "STALE_SOURCE",
      receipt: parsed,
      detail: "The protected source changed after the recorded Once transformation.",
    };
  }

  if (parsed.status === "PROTECTED") {
    return {
      state: "CURRENT_PROTECTED",
      receipt: parsed,
    };
  }

  return {
    state: "CURRENT_PENDING_PROOF",
    receipt: parsed,
  };
}

export async function markProtectionReceiptVerified(
  requestedPath: string,
  proof: VerifiedRouteProofInput,
): Promise<{ path: string; receipt: VerifiedProtectionReceipt }> {
  if (
    typeof proof.operationId !== "string" ||
    proof.operationId.trim() === "" ||
    !Number.isSafeInteger(proof.attempts) ||
    proof.attempts < 2 ||
    proof.sideEffects !== 1
  ) {
    throw new Error(
      "Route proof cannot promote protection without a stable proof operation, at least two attempts, and exactly one synthetic side effect.",
    );
  }

  const inspection = await inspectProtectionReceipt(requestedPath);

  if (!inspection) {
    throw new Error(
      "No protection receipt exists. Apply a supported transformation before route verification.",
    );
  }

  if (inspection.state === "INVALID_RECEIPT") {
    throw new Error(
      `Protection receipt is invalid: ${inspection.detail}`,
    );
  }

  if (inspection.state === "STALE_SOURCE") {
    throw new Error(
      `Protection receipt is stale: ${inspection.detail}`,
    );
  }

  if (inspection.state === "CURRENT_PROTECTED") {
    return {
      path: receiptPath(path.resolve(requestedPath)),
      receipt: inspection.receipt,
    };
  }

  const verifiedAt = new Date().toISOString();
  const receipt: VerifiedProtectionReceipt = Object.freeze({
    schema_version: 1,
    status: "PROTECTED",
    once_protected: true,
    applied_at: inspection.receipt.applied_at,
    callsite_ref: inspection.receipt.callsite_ref,
    file: inspection.receipt.file,
    provider: inspection.receipt.provider,
    transformer_id: inspection.receipt.transformer_id,
    source_sha256: inspection.receipt.source_sha256,
    applied_sha256: inspection.receipt.applied_sha256,
    execution_route: inspection.receipt.execution_route,
    route_proof: Object.freeze({
      required: ONCE_EXECUTE_LOST_ACK_PROOF,
      state: "PASS",
      verified_at: verifiedAt,
      operation_id: proof.operationId,
      attempts: proof.attempts,
      side_effects: 1,
    }),
  });

  const root = path.resolve(requestedPath);
  const target = await persistReceipt(root, receipt);
  return { path: target, receipt };
}