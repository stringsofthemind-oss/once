/** Storage seam for the existing protectLocal kernel; not a second dispatcher. */
export interface ExecutionRow {
  fingerprint: string;
  state: "CLAIMED" | "UNKNOWN" | "CONFIRMED";
  result_json: string | null;
  owner: string | null;
  lease_until: number | null;
}

export interface ExecutionStore {
  /** Atomic insert-if-absent; expired claims become UNKNOWN, never re-owned. */
  reserve(id: string, fingerprint: string, owner: string, leaseMs: number): Promise<{
    dispatch: boolean; row?: ExecutionRow;
  }>;
  /** Must check current authority and the exact live claim before dispatch. */
  assertDispatch(id: string, fingerprint: string, owner: string): Promise<void>;
  markUnknown(id: string, fingerprint: string, owner: string): Promise<void>;
  /** Compare-and-set confirmation; false means execution authority was lost. */
  confirm(id: string, fingerprint: string, owner: string, result: string): Promise<boolean>;
  /** Only the kernel's validated authoritative provider observation reaches here. */
  reconcile(id: string, fingerprint: string, result: string): Promise<ExecutionRow | undefined>;
  close(): void;
}

/** Trusted host-owned storage. Must never be selected from model/tool arguments. */
export interface ExecutionAuthority {
  open(): Promise<ExecutionStore>;
}
