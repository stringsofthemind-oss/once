import {
  readFile,
  writeFile
} from "node:fs/promises";

const protectPath =
  new URL(
    "../src/protect.ts",
    import.meta.url
  );

const applyPath =
  new URL(
    "../src/apply.ts",
    import.meta.url
  );

function replaceOnce(
  source,
  before,
  after,
  label
) {
  const first =
    source.indexOf(before);

  if (first < 0) {
    throw new Error(
      `slice6 authoring anchor missing: ${label}`
    );
  }

  if (
    source.indexOf(
      before,
      first + before.length
    ) >= 0
  ) {
    throw new Error(
      `slice6 authoring anchor duplicated: ${label}`
    );
  }

  return (
    source.slice(0, first) +
    after +
    source.slice(first + before.length)
  );
}

let protect =
  await readFile(
    protectPath,
    "utf8"
  );

protect = replaceOnce(
  protect,
`import {
  buildHttpWritePatchV1
} from "./transformers/http-patch-plan-v1.js";
`,
`import {
  buildHttpWritePatchV1
} from "./transformers/http-patch-plan-v1.js";

import {
  buildHttpNativeResponsePlanV1
} from "./transformers/http-native-response-plan-v1.js";
`,
  "protect imports"
);

protect = replaceOnce(
  protect,
`type CapabilityDeclaration = {
  category: string;
  action_type: string;
  allowed_urls?: string[];
  description?: string;
};`,
`type CapabilityDeclaration = {
  category: string;
  action_type: string;
  allowed_urls?: string[];
  description?: string;
  version_id?: string;
  response_replay?: string;
  response_replay_v2?: string;
};`,
  "protect capability declaration"
);

protect = replaceOnce(
  protect,
`  target_url?: string;
  runtime_operation_id_rule: string;`,
`  target_url?: string;
  capability_fingerprint?: string;
  runtime_operation_id_rule: string;`,
  "protect candidate fingerprint"
);

const protectStart =
  protect.indexOf(
`  const result =
    transformHttpWriteV1({`
  );

const protectEndMarker =
`  candidate.transformer_reason =
    "Complete deterministic source patch successfully planned in memory.";`;

const protectEndBase =
  protect.indexOf(
    protectEndMarker,
    protectStart
  );

if (
  protectStart < 0 ||
  protectEndBase < 0
) {
  throw new Error(
    "slice6 protect transformer block anchor missing"
  );
}

const protectEnd =
  protectEndBase +
  protectEndMarker.length;

const protectReplacement =
`  const result =
    transformHttpWriteV1({
      statement: extracted.statement,
      functionSource,
      provider: provider ?? "__once_source_preflight__"
    });

  if (!result.eligible) {
    markUnsupported(result.reason);
    return;
  }

  candidate.source_shape = "SUPPORTED";
  candidate.source_shape_reason =
    "The exact request shape matches the current proven HTTP transformer contract.";
  candidate.target_url = result.url;

  if (!provider) {
    candidate.automation_reason =
      \`Source shape matches the proven HTTP transformer, but provider mapping is still required before any rewrite can become eligible. Exact target: \${result.url}.\`;
    return;
  }

  if (candidate.automation_status !== "PROVIDER_CAPABILITY_DECLARED") {
    candidate.automation_reason =
      "Source shape matches the proven HTTP transformer, but the configured provider does not yet declare the required http_write_v1 capability for this callsite.";
    return;
  }

  const capability = manifest?.capabilities.find(
    item => item.category === "HTTP_WRITE" && item.action_type === "http_write_v1"
  );
  if (!capability) return;

  const capabilityEvidence = {
    name:
      provider,
    version_id:
      capability.version_id,
    response_replay:
      capability.response_replay,
    response_replay_v2:
      capability.response_replay_v2,
    allowed_urls:
      capability.allowed_urls
  };

  const nativeResponsePlan =
    buildHttpNativeResponsePlanV1({
      source,
      awaitFetchStatement:
        extracted.statement,
      awaitFetchStartOffset:
        extracted.startOffset,
      functionSource,
      provider,
      capability:
        capabilityEvidence
    });

  if (nativeResponsePlan.matched) {
    candidate.source_shape_reason =
      \`The request and \${nativeResponsePlan.kind === "assignment" ? "assigned" : "returned"} native Response shape are inside the proven replay-v2 boundary.\`;

    if (!nativeResponsePlan.eligible) {
      candidate.transformer_reason =
        nativeResponsePlan.reason;
      candidate.automation_reason =
        \`Native Response source shape detected, but automatic protection remains fail-closed: \${nativeResponsePlan.reason}\`;
      return;
    }

    candidate.automation_status = "PATCHABLE";
    candidate.automation_reason =
      "Scanner match, provider replay-v2 capability, native Response transformer, deterministic helper binding and full-source patch planning all succeeded.";
    candidate.auto_apply_eligible = true;
    candidate.transformer_id =
      nativeResponsePlan.transformerId;
    candidate.transformer_reason =
      "Complete deterministic native Response source patch successfully planned in memory.";
    candidate.binding_required = false;
    candidate.binding_strategy =
      nativeResponsePlan.bindingStrategy;
    candidate.patch_plan_id =
      nativeResponsePlan.patchPlan;
    candidate.source_sha256 =
      nativeResponsePlan.sourceSha256;
    candidate.proposed_source_sha256 =
      nativeResponsePlan.proposedSourceSha256;
    candidate.target_url =
      nativeResponsePlan.targetUrl;
    candidate.capability_fingerprint =
      nativeResponsePlan.capabilityFingerprint;
    return;
  }

  const allowedUrls = capability.allowed_urls;
  if (!Array.isArray(allowedUrls) || !allowedUrls.includes(result.url)) {
    candidate.transformer_reason =
      \`Capability does not explicitly allow target URL \${result.url}.\`;
    return;
  }

  candidate.automation_status = "TRANSFORMER_MATCHED";
  candidate.automation_reason =
    "The exact source pattern was accepted by the proven ts_fetch_post_void_v1 transformer. Full source-patch planning is now being validated.";
  candidate.transformer_id = result.transformer;
  candidate.transformer_reason = "Exact transformer contract matched.";
  candidate.binding_required = result.requiresOnceBinding;

  const patchPlan = buildHttpWritePatchV1({
    source,
    statement: extracted.statement,
    functionSource,
    provider
  });

  if (!patchPlan.eligible) {
    candidate.transformer_reason =
      \`Transformer matched, but complete patch planning failed closed: \${patchPlan.reason}\`;
    return;
  }

  candidate.automation_status = "PATCHABLE";
  candidate.automation_reason =
    "Scanner match, provider capability, transformer contract, call-site Once binding and deterministic full-source patch planning all succeeded.";
  candidate.auto_apply_eligible = true;
  candidate.binding_required = false;
  candidate.binding_strategy = patchPlan.bindingStrategy;
  candidate.patch_plan_id = patchPlan.patchPlan;
  candidate.source_sha256 = patchPlan.sourceSha256;
  candidate.proposed_source_sha256 = patchPlan.proposedSourceSha256;
  candidate.transformer_reason =
    "Complete deterministic source patch successfully planned in memory.";`;

protect =
  protect.slice(0, protectStart) +
  protectReplacement +
  protect.slice(protectEnd);

await writeFile(
  protectPath,
  protect,
  "utf8"
);

let apply =
  await readFile(
    applyPath,
    "utf8"
  );

apply = replaceOnce(
  apply,
`import {
  buildHttpWritePatchV1
} from "./transformers/http-patch-plan-v1.js";
`,
`import {
  buildHttpWritePatchV1
} from "./transformers/http-patch-plan-v1.js";

import {
  buildHttpNativeResponsePlanV1
} from "./transformers/http-native-response-plan-v1.js";
`,
  "apply imports"
);

apply = replaceOnce(
  apply,
`  target_url?: string;
};`,
`  target_url?: string;
  capability_fingerprint?: string;
};`,
  "apply candidate fingerprint"
);

apply = replaceOnce(
  apply,
`    allowed_urls?: string[];
  }>;
};`,
`    allowed_urls?: string[];
    version_id?: string;
    response_replay?: string;
    response_replay_v2?: string;
  }>;
};`,
  "apply capability declaration"
);

apply = replaceOnce(
  apply,
`  if (
    candidate.category !==
      "HTTP_WRITE" ||
    candidate.transformer_id !==
      "ts_fetch_post_void_v1" ||
    candidate.patch_plan_id !==
      "ts_fetch_post_void_patch_v1"
  ) {
    throw new Error(
      "Candidate is outside the supported v1.0 apply contract."
    );
  }`,
`  const supportedApplyContract =
    candidate.category === "HTTP_WRITE" &&
    (
      (
        candidate.transformer_id ===
          "ts_fetch_post_void_v1" &&
        candidate.patch_plan_id ===
          "ts_fetch_post_void_patch_v1"
      ) ||
      (
        candidate.transformer_id ===
          "ts_fetch_response_assignment_v1" &&
        candidate.patch_plan_id ===
          "ts_fetch_response_assignment_patch_v1"
      ) ||
      (
        candidate.transformer_id ===
          "ts_fetch_response_return_v1" &&
        candidate.patch_plan_id ===
          "ts_fetch_response_return_patch_v1"
      )
    );

  if (!supportedApplyContract) {
    throw new Error(
      "Candidate is outside the supported v1.0 apply contract."
    );
  }`,
  "apply contract dispatch"
);

const applyPatchStart =
  apply.indexOf(
`  const patch =
    buildHttpWritePatchV1({`
  );

const applyPatchEndMarker =
`  await verifyTypeScript(
    patch.proposedSource,
    sourcePath
  );`;

const applyPatchEndBase =
  apply.indexOf(
    applyPatchEndMarker,
    applyPatchStart
  );

if (
  applyPatchStart < 0 ||
  applyPatchEndBase < 0
) {
  throw new Error(
    "slice6 apply patch block anchor missing"
  );
}

const applyPatchEnd =
  applyPatchEndBase +
  applyPatchEndMarker.length;

const applyPatchReplacement =
`  const capabilityEvidence = {
    name:
      provider,
    version_id:
      capability.version_id,
    response_replay:
      capability.response_replay,
    response_replay_v2:
      capability.response_replay_v2,
    allowed_urls:
      capability.allowed_urls
  };

  let proposedSource: string;
  let recomputedTargetUrl: string;
  let recomputedSourceSha256: string;
  let recomputedProposedSourceSha256: string;
  let recomputedPatchPlanId: string;
  let recomputedCapabilityFingerprint: string | undefined;

  if (
    candidate.transformer_id ===
      "ts_fetch_post_void_v1"
  ) {
    const patch =
      buildHttpWritePatchV1({
        source:
          originalSource,
        statement:
          extracted.statement,
        functionSource,
        provider
      });

    if (!patch.eligible) {
      throw new Error(
        "Patch no longer satisfies transformer contract: " +
        patch.reason
      );
    }

    proposedSource =
      patch.proposedSource;
    recomputedTargetUrl =
      patch.targetUrl;
    recomputedSourceSha256 =
      patch.sourceSha256;
    recomputedProposedSourceSha256 =
      patch.proposedSourceSha256;
    recomputedPatchPlanId =
      patch.patchPlan;
  } else {
    const nativePlan =
      buildHttpNativeResponsePlanV1({
        source:
          originalSource,
        awaitFetchStatement:
          extracted.statement,
        awaitFetchStartOffset:
          extracted.startOffset,
        functionSource,
        provider,
        capability:
          capabilityEvidence
      });

    if (
      !nativePlan.matched ||
      !nativePlan.eligible
    ) {
      throw new Error(
        "Native Response patch no longer satisfies transformer contract: " +
        (
          nativePlan.matched
            ? nativePlan.reason
            : "exact assigned/returned Response statement could not be re-identified"
        )
      );
    }

    if (
      nativePlan.transformerId !==
        candidate.transformer_id
    ) {
      throw new Error(
        "Recomputed native Response transformer differs from Protect plan."
      );
    }

    proposedSource =
      nativePlan.proposedSource;
    recomputedTargetUrl =
      nativePlan.targetUrl;
    recomputedSourceSha256 =
      nativePlan.sourceSha256;
    recomputedProposedSourceSha256 =
      nativePlan.proposedSourceSha256;
    recomputedPatchPlanId =
      nativePlan.patchPlan;
    recomputedCapabilityFingerprint =
      nativePlan.capabilityFingerprint;

    if (
      !candidate.capability_fingerprint ||
      recomputedCapabilityFingerprint !==
        candidate.capability_fingerprint
    ) {
      throw new Error(
        "Provider replay-v2 capability evidence changed after Protect planning."
      );
    }
  }

  if (
    recomputedPatchPlanId !==
      candidate.patch_plan_id
  ) {
    throw new Error(
      "Recomputed patch-plan contract differs from Protect plan."
    );
  }

  if (
    recomputedTargetUrl !==
    candidate.target_url
  ) {
    throw new Error(
      "Recomputed target URL differs from Protect plan."
    );
  }

  if (
    recomputedProposedSourceSha256 !==
    candidate.proposed_source_sha256
  ) {
    throw new Error(
      "Recomputed proposed-source fingerprint differs from Protect plan."
    );
  }

  await verifyTypeScript(
    proposedSource,
    sourcePath
  );`;

apply =
  apply.slice(0, applyPatchStart) +
  applyPatchReplacement +
  apply.slice(applyPatchEnd);

apply = apply.replaceAll(
  "patch.proposedSource",
  "proposedSource"
);

apply = apply.replaceAll(
  "patch.proposedSourceSha256",
  "recomputedProposedSourceSha256"
);

apply = apply.replaceAll(
  "patch.sourceSha256",
  "recomputedSourceSha256"
);

await writeFile(
  applyPath,
  apply,
  "utf8"
);

console.log(
  "slice6 protect/apply integration authored"
);
