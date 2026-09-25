export type ToolEvidenceLevel =
  | "EXECUTED"
  | "MODEL_VISIBLE"
  | "RUNTIME_REGISTERED"
  | "SERVER_AUTHORITATIVE"
  | "HOST_CONFIGURED"
  | "SOURCE_DISCOVERED"
  | "REGISTRY_CANDIDATE";

export type ToolEffectClass =
  | "READ_ONLY"
  | "GENERATION_ONLY"
  | "LOCAL_MUTATION"
  | "EXTERNAL_LOW_IMPACT_MUTATION"
  | "EXTERNAL_COMMUNICATION"
  | "EXTERNAL_BUSINESS_MUTATION"
  | "DATABASE_MUTATION"
  | "QUEUE_EVENT_MUTATION"
  | "STORAGE_MUTATION"
  | "CODE_REPOSITORY_MUTATION"
  | "MONEY_MOVEMENT"
  | "IDENTITY_ACCESS_SECURITY"
  | "PRODUCTION_INFRASTRUCTURE"
  | "DESTRUCTIVE_ADMIN"
  | "DYNAMIC_EXECUTION"
  | "UNKNOWN";

export type ToolQualification =
  | "NOT_APPLICABLE"
  | "UNLIKELY"
  | "REVIEW_REQUIRED"
  | "QUALIFIED"
  | "UNKNOWN";

export type ToolProtectionState =
  | "NONE"
  | "NATIVE_IDEMPOTENCY"
  | "AUTHORITATIVE_RECONCILIATION"
  | "ONCE_HEALTHY"
  | "ONCE_UNVERIFIED";

export type ToolImportanceBand =
  | "I0"
  | "I1"
  | "I2"
  | "I3"
  | "I4"
  | "I5";

export type ToolActionBand =
  | "BYPASS"
  | "OBSERVE"
  | "REVIEW"
  | "QUALIFY"
  | "PROTECT_PRIORITY"
  | "CRITICAL_GAP";

export type ToolImportanceAssessment = {
  effectClass: ToolEffectClass;
  criticality: {
    score: number;
    band: ToolImportanceBand;
    confidence: number;
    reasons: string[];
  };
  qualification: ToolQualification;
  actionPriority: {
    score: number;
    band: ToolActionBand;
    reasons: string[];
  };
  protection: ToolProtectionState;
  protectedCritical: boolean;
};

export type ToolImportanceInput = {
  name: string;
  description?: string;
  sourceCategory?: string;
  evidence: ToolEvidenceLevel;
  qualification?: ToolQualification;
  protection?: ToolProtectionState;
  readOnlyHint?: boolean;
};

const evidenceAdjustment: Record<ToolEvidenceLevel, number> = {
  EXECUTED: 15,
  MODEL_VISIBLE: 10,
  RUNTIME_REGISTERED: 7,
  SERVER_AUTHORITATIVE: 4,
  HOST_CONFIGURED: 2,
  SOURCE_DISCOVERED: 0,
  REGISTRY_CANDIDATE: -30
};

const protectionAdjustment: Record<ToolProtectionState, number> = {
  NONE: 10,
  NATIVE_IDEMPOTENCY: -5,
  AUTHORITATIVE_RECONCILIATION: -15,
  ONCE_HEALTHY: -35,
  ONCE_UNVERIFIED: 0
};

function clamp(
  value: number,
  minimum = 0,
  maximum = 100
): number {
  return Math.max(
    minimum,
    Math.min(maximum, value)
  );
}

function criticalityBand(
  score: number
): ToolImportanceBand {
  if (score >= 85) return "I5";
  if (score >= 70) return "I4";
  if (score >= 50) return "I3";
  if (score >= 30) return "I2";
  if (score >= 10) return "I1";
  return "I0";
}

function actionBand(
  score: number
): ToolActionBand {
  if (score >= 95) return "CRITICAL_GAP";
  if (score >= 80) return "PROTECT_PRIORITY";
  if (score >= 60) return "QUALIFY";
  if (score >= 40) return "REVIEW";
  if (score >= 20) return "OBSERVE";
  return "BYPASS";
}

function inferredQualification(
  effectClass: ToolEffectClass
): ToolQualification {
  switch (effectClass) {
    case "READ_ONLY":
    case "GENERATION_ONLY":
      return "NOT_APPLICABLE";
    case "UNKNOWN":
    case "DYNAMIC_EXECUTION":
      return "UNKNOWN";
    case "LOCAL_MUTATION":
      return "UNLIKELY";
    default:
      return "REVIEW_REQUIRED";
  }
}

function inferEffect(
  input: ToolImportanceInput
): {
  effectClass: ToolEffectClass;
  base: number;
  confidence: number;
  reasons: string[];
} {
  const text = [
    input.name,
    input.description ?? "",
    input.sourceCategory ?? ""
  ].join(" ").toLowerCase();

  if (input.readOnlyHint === true) {
    return {
      effectClass: "READ_ONLY",
      base: 5,
      confidence: 0.78,
      reasons: ["read_only_hint"]
    };
  }

  if (
    /terraform\s*(destroy|apply)|kubectl.*(?:delete|apply)|destroy.*(?:prod|production)|(?:prod|production).*(?:destroy|delete|purge|drop)/.test(text)
  ) {
    return {
      effectClass: "DESTRUCTIVE_ADMIN",
      base: 95,
      confidence: 0.94,
      reasons: ["destructive_production_operation"]
    };
  }

  if (
    /refund|charge|payment|payout|transfer|capture.*(?:card|payment)|money|financial/.test(text)
  ) {
    return {
      effectClass: "MONEY_MOVEMENT",
      base: 90,
      confidence: 0.93,
      reasons: ["money_movement"]
    };
  }

  if (
    /grant.*(?:admin|role|permission)|revoke.*(?:access|role|permission)|rotate.*(?:key|credential|secret)|deleteuser|disableuser|identity|iam|security policy|account mutation/.test(text)
  ) {
    return {
      effectClass: "IDENTITY_ACCESS_SECURITY",
      base: 90,
      confidence: 0.9,
      reasons: ["identity_access_security_change"]
    };
  }

  if (
    /deploy|production|terraform|kubectl|helm|cloudformation|dns|infrastructure/.test(text)
  ) {
    return {
      effectClass: "PRODUCTION_INFRASTRUCTURE",
      base: 85,
      confidence: 0.84,
      reasons: ["production_or_infrastructure_change"]
    };
  }

  if (
    /merge.*pull|pull.*merge|git.*push|create.*tag|publish.*release|repository|github.*(?:create|update|delete)|code_repository/.test(text)
  ) {
    return {
      effectClass: "CODE_REPOSITORY_MUTATION",
      base: 72,
      confidence: 0.82,
      reasons: ["code_repository_mutation"]
    };
  }

  if (
    /database|prisma|insert|upsert|sql.*(?:update|delete|insert)|delete.*record|update.*record/.test(text)
  ) {
    return {
      effectClass: "DATABASE_MUTATION",
      base: 62,
      confidence: 0.82,
      reasons: ["database_mutation"]
    };
  }

  if (
    /queue|kafka|sns|sqs|pubsub|enqueue|publish.*event|event publication/.test(text)
  ) {
    return {
      effectClass: "QUEUE_EVENT_MUTATION",
      base: 60,
      confidence: 0.82,
      reasons: ["queue_or_event_mutation"]
    };
  }

  if (
    /sendmail|sendemail|sendmessage|sendsms|postmessage|email|sms|slack|teams|discord|messaging/.test(text)
  ) {
    return {
      effectClass: "EXTERNAL_COMMUNICATION",
      base: 55,
      confidence: 0.88,
      reasons: ["external_communication"]
    };
  }

  if (
    /booking|reservation|appointment|order mutation|createorder|cancelorder|business mutation/.test(text)
  ) {
    return {
      effectClass: "EXTERNAL_BUSINESS_MUTATION",
      base: 65,
      confidence: 0.86,
      reasons: ["external_business_mutation"]
    };
  }

  if (
    /putobject|deleteobject|uploadfile|uploadobject|object storage|blob/.test(text)
  ) {
    return {
      effectClass: "STORAGE_MUTATION",
      base: 50,
      confidence: 0.82,
      reasons: ["storage_mutation"]
    };
  }

  if (
    /writefile|appendfile|unlink|rename|local filesystem|file_write/.test(text)
  ) {
    return {
      effectClass: "LOCAL_MUTATION",
      base: 25,
      confidence: 0.86,
      reasons: ["local_mutation"]
    };
  }

  if (
    /http_write|http_delete|http request|shell|computer|browser|code execution|execute command/.test(text)
  ) {
    return {
      effectClass: "DYNAMIC_EXECUTION",
      base: 55,
      confidence: 0.58,
      reasons: ["dynamic_or_generic_execution"]
    };
  }

  if (
    /\b(get|list|read|search|fetch|lookup|inspect|query)\b|read_only/.test(text)
  ) {
    return {
      effectClass: "READ_ONLY",
      base: 4,
      confidence: 0.66,
      reasons: ["read_semantics"]
    };
  }

  if (
    /summar|generate|reason|classify|translate|generation/.test(text)
  ) {
    return {
      effectClass: "GENERATION_ONLY",
      base: 4,
      confidence: 0.64,
      reasons: ["generation_semantics"]
    };
  }

  return {
    effectClass: "UNKNOWN",
    base: 50,
    confidence: 0.25,
    reasons: ["insufficient_effect_evidence"]
  };
}

export function assessToolImportance(
  input: ToolImportanceInput
): ToolImportanceAssessment {
  const inferred = inferEffect(input);
  const text = [
    input.name,
    input.description ?? "",
    input.sourceCategory ?? ""
  ].join(" ").toLowerCase();

  let criticality = inferred.base;
  const criticalityReasons = [...inferred.reasons];

  if (
    inferred.effectClass !== "READ_ONLY" &&
    inferred.effectClass !== "GENERATION_ONLY" &&
    /irreversible|destructive|destroy|purge|terminate|drop\b/.test(text)
  ) {
    criticality += 15;
    criticalityReasons.push("irreversible_or_destructive");
  }

  if (
    /bulk|batch|all records|multi-record/.test(text)
  ) {
    criticality += 10;
    criticalityReasons.push("bulk_scope");
  }

  if (
    inferred.effectClass === "QUEUE_EVENT_MUTATION"
  ) {
    criticality += 8;
    criticalityReasons.push("downstream_fanout");
  }

  criticality = clamp(criticality);

  const qualification =
    input.qualification ??
    inferredQualification(inferred.effectClass);

  const protection =
    input.protection ?? "NONE";

  let priority =
    criticality +
    evidenceAdjustment[input.evidence] +
    protectionAdjustment[protection];

  const actionReasons: string[] = [
    `evidence_${input.evidence.toLowerCase()}`,
    `protection_${protection.toLowerCase()}`
  ];

  switch (qualification) {
    case "QUALIFIED":
      priority += 15;
      actionReasons.push("once_qualified");
      break;
    case "REVIEW_REQUIRED":
      priority += 5;
      actionReasons.push("qualification_review_required");
      break;
    case "UNKNOWN":
      priority += 5;
      actionReasons.push("qualification_unknown");
      break;
    case "UNLIKELY":
      priority -= 20;
      actionReasons.push("once_unlikely");
      break;
    case "NOT_APPLICABLE":
      priority = Math.min(priority, 15);
      actionReasons.push("once_not_applicable");
      break;
  }

  priority = clamp(priority);

  return {
    effectClass: inferred.effectClass,
    criticality: {
      score: criticality,
      band: criticalityBand(criticality),
      confidence: inferred.confidence,
      reasons: criticalityReasons
    },
    qualification,
    actionPriority: {
      score: priority,
      band: actionBand(priority),
      reasons: actionReasons
    },
    protection,
    protectedCritical:
      protection === "ONCE_HEALTHY" &&
      criticality >= 70
  };
}
