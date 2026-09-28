import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const PROTECTION_RECEIPT_FILE =
  "protection-status.json" as const;

export const HOSTED_ONCE_EXECUTE_ROUTE =
  "HOSTED_ONCE_EXECUTE_V1" as const;

export const HOSTED_LOST_ACK_PROOF =
  "HOSTED_LOST_ACK_REPLAY_V1" as const;

export type ProtectionReceipt = Readonly<{
  schema_version: 1;
  status: "APPLIED_PENDING_ROUTE_PROOF";
  once_protected: false;
  applied_at: string;
  callsite_ref: string;
  file: string;
  provider: string;
  transformer_id: "ts_fetch_post_void_v1";
  source_sha256: string;
  applied_sha256: string;
  execution_route: typeof HOSTED_ONCE_EXECUTE_ROUTE;
  route_proof: Readonly<{
    required: typeof HOSTED_LOST_ACK_PROOF;
    state: "PENDING";
    verified_at: null;
  }>;
}>;

export type ProtectionReceiptInspection =
  | Readonly<{
      state: "CURRENT_PENDING_PROOF";
      receipt: ProtectionReceipt;
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

function sha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

function receiptPath(root: string): string {
  return path.join(root, ".once", PROTECTION_RECEIPT_FILE);
}

function isProtectionReceipt(value: unknown): value is ProtectionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const receipt = value as Record<string, unknown>;
  const routeProof = receipt.route_proof as Record<string, unknown> | undefined;

  return (
    receipt.schema_version === 1 &&
    receipt.status === "APPLIED_PENDING_ROUTE_PROOF" &&
    receipt.once_protected === false &&
    typeof receipt.applied_at === "string" &&
    typeof receipt.callsite_ref === "string" &&
    typeof receipt.file === "string" &&
    typeof receipt.provider === "string" &&
    receipt.transformer_id === "ts_fetch_post_void_v1" &&
    typeof receipt.source_sha256 === "string" &&
    typeof receipt.applied_sha256 === "string" &&
    receipt.execution_route === HOSTED_ONCE_EXECUTE_ROUTE &&
    Boolean(routeProof) &&
    routeProof?.required === HOSTED_LOST_ACK_PROOF &&
    routeProof?.state === "PENDING" &&
    routeProof?.verified_at === null
  );
}

export async function writeProtectionReceipt(
  requestedPath: string,
  input: WriteProtectionReceiptInput,
): Promise<{ path: string; receipt: ProtectionReceipt }> {
  const root = path.resolve(requestedPath);
  const onceDirectory = path.join(root, ".once");
  const target = receiptPath(root);
  const temporary = path.join(
    onceDirectory,
    `.once-protection-status-${process.pid}-${Date.now()}.tmp`,
  );

  const receipt: ProtectionReceipt = Object.freeze({
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
    execution_route: HOSTED_ONCE_EXECUTE_ROUTE,
    route_proof: Object.freeze({
      required: HOSTED_LOST_ACK_PROOF,
      state: "PENDING",
      verified_at: null,
    }),
  });

  await fs.mkdir(onceDirectory, { recursive: true });

  try {
    await fs.writeFile(
      temporary,
      JSON.stringify(receipt, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" },
    );

    // Windows does not reliably replace an existing target with rename().
    // Removing the old receipt first is safe because the receipt is secondary
    // metadata: applyProtectionPlan rolls application source back if this write
    // fails, and Doctor treats a missing receipt as no protection claim.
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }

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

  return {
    state: "CURRENT_PENDING_PROOF",
    receipt: parsed,
  };
}
