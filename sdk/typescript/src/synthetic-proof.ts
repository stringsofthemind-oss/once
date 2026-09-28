import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LocalProtectionError,
  protectLocal
} from "./local.js";

type ProofInput = {
  id: string;
  amount: number;
};

type ProofReceipt = {
  receipt: string;
};

export type SyntheticProtectionProof = {
  passed: true;
  first_attempt_state: "UNKNOWN";
  immediate_retry_state: "UNKNOWN";
  reconciled_state: "CONFIRMED";
  replay_state: "CONFIRMED";
  external_synthetic_effects: 1;
};

function errorCode(
  error: unknown
): string | undefined {
  return error instanceof LocalProtectionError
    ? error.code
    : undefined;
}

async function readEffects(
  effectsPath: string
): Promise<unknown[]> {
  return JSON.parse(
    await fs.readFile(
      effectsPath,
      "utf8"
    )
  ) as unknown[];
}

async function appendEffect(
  effectsPath: string,
  value: unknown
): Promise<void> {
  const effects =
    await readEffects(effectsPath);

  effects.push(value);

  await fs.writeFile(
    effectsPath,
    JSON.stringify(effects),
    "utf8"
  );
}

export async function runSyntheticProtectionProof(): Promise<SyntheticProtectionProof> {
  const [major, minor] =
    process.versions.node
      .split(".")
      .map(value => Number.parseInt(value, 10));

  if (
    major < 24 ||
    (major === 24 && minor < 15)
  ) {
    throw new Error(
      "Synthetic local retry proof requires Node.js 24.15 or later."
    );
  }

  const directory =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        "once-synthetic-proof-"
      )
    );

  const statePath =
    path.join(
      directory,
      "operations.sqlite"
    );

  const effectsPath =
    path.join(
      directory,
      "effects.json"
    );

  await fs.writeFile(
    effectsPath,
    "[]",
    "utf8"
  );

  const input: ProofInput = {
    id: "once-synthetic-effect-v1",
    amount: 1
  };

  try {
    const first =
      protectLocal(
        async (value: ProofInput): Promise<ProofReceipt> => {
          await appendEffect(
            effectsPath,
            {
              id: value.id,
              amount: value.amount
            }
          );

          throw new Error(
            "synthetic acknowledgement lost after effect"
          );
        },
        {
          statePath,
          id:
            value => value.id,
          payload:
            value => ({
              amount: value.amount
            })
        }
      );

    let firstAttemptState:
      "UNKNOWN" | undefined;

    try {
      await first(input);
    } catch (error) {
      if (errorCode(error) !== "UNKNOWN") {
        throw error;
      }

      firstAttemptState = "UNKNOWN";
    }

    if (firstAttemptState !== "UNKNOWN") {
      throw new Error(
        "Synthetic proof expected the lost acknowledgement to become durable UNKNOWN."
      );
    }

    let effects =
      await readEffects(effectsPath);

    if (effects.length !== 1) {
      throw new Error(
        `Synthetic proof expected exactly one committed effect after the first attempt; observed ${effects.length}.`
      );
    }

    let retryState:
      "UNKNOWN" | undefined;

    try {
      await first(input);
    } catch (error) {
      if (errorCode(error) !== "UNKNOWN") {
        throw error;
      }

      retryState = "UNKNOWN";
    }

    if (retryState !== "UNKNOWN") {
      throw new Error(
        "Synthetic proof expected the immediate retry to remain blocked as UNKNOWN."
      );
    }

    effects =
      await readEffects(effectsPath);

    if (effects.length !== 1) {
      throw new Error(
        `Synthetic retry dispatched a duplicate effect; observed ${effects.length} effects.`
      );
    }

    const reconciled =
      protectLocal(
        async (): Promise<ProofReceipt> => {
          throw new Error(
            "synthetic reconciliation must not dispatch the protected effect"
          );
        },
        {
          statePath,
          id:
            value => value.id,
          payload:
            value => ({
              amount: value.amount
            }),
          reconcile:
            async () => ({
              state: "CONFIRMED" as const,
              result: {
                receipt:
                  "synthetic-provider-confirmed"
              }
            })
        }
      );

    const confirmed =
      await reconciled(input);

    if (
      confirmed.receipt !==
      "synthetic-provider-confirmed"
    ) {
      throw new Error(
        "Synthetic reconciliation did not return the expected confirmed receipt."
      );
    }

    const replay =
      await first(input);

    if (
      replay.receipt !==
      "synthetic-provider-confirmed"
    ) {
      throw new Error(
        "Synthetic confirmed replay did not return the durable receipt."
      );
    }

    effects =
      await readEffects(effectsPath);

    if (effects.length !== 1) {
      throw new Error(
        `Synthetic proof finished with ${effects.length} effects instead of exactly one.`
      );
    }

    return {
      passed: true,
      first_attempt_state: "UNKNOWN",
      immediate_retry_state: "UNKNOWN",
      reconciled_state: "CONFIRMED",
      replay_state: "CONFIRMED",
      external_synthetic_effects: 1
    };
  } finally {
    await fs.rm(
      directory,
      {
        recursive: true,
        force: true
      }
    );
  }
}

export async function printSyntheticProtectionProof(): Promise<void> {
  console.log("");
  console.log("Once Synthetic Retry Proof");
  console.log("==========================");
  console.log("");
  console.log(
    "Mode: isolated local fake effect"
  );
  console.log(
    "Real provider/tool execution: none"
  );
  console.log(
    "Project source changes: none"
  );

  const result =
    await runSyntheticProtectionProof();

  console.log("");
  console.log(
    `1. Effect committed, acknowledgement lost -> ${result.first_attempt_state}`
  );
  console.log(
    `2. Immediate retry -> ${result.immediate_retry_state} (blocked, no redispatch)`
  );
  console.log(
    `3. Authoritative synthetic reconciliation -> ${result.reconciled_state}`
  );
  console.log(
    `4. Confirmed replay -> ${result.replay_state}`
  );
  console.log("");
  console.log(
    `External synthetic effects: ${result.external_synthetic_effects}`
  );
  console.log(
    "SYNTHETIC RETRY PROOF: PASS"
  );
  console.log("");
  console.log(
    "This proves the local Once retry state machine in isolation. It does not claim that this project's real tools are wired or provider-reconcilable."
  );
}
