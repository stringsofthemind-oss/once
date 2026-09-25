export {
  CONNECT_DECISION,
  classifyConnectOperation,
} from "./classifier.js";

export type {
  ConnectDecision,
  ConnectSafetyDeclaration,
  ConnectClassification,
} from "./classifier.js";

export {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
  classifyConnectTools,
} from "./tool-classifier.js";

export type {
  ConnectToolDecision,
  ConnectToolAnnotations,
  ConnectToolDescriptor,
  ConnectToolClassificationReason,
  ConnectToolClassification,
} from "./tool-classifier.js";

export {
  CONNECT_MANIFEST_VERSION,
  planConnectToolManifest,
} from "./manifest.js";

export type {
  ConnectManifestToolSource,
  ConnectManifestPlanEntry,
  ConnectManifestPlanSummary,
  ConnectManifestPlan,
} from "./manifest.js";

export {
  resolveConnectToolOperationIdentity,
} from "./identity.js";

export type {
  ConnectIdentitySource,
  ConnectIdentityResult,
  ResolveConnectIdentityInput,
} from "./identity.js";

export {
  connectLocalAgentToolAuto,
  AgentToolConnectionError,
} from "./local-agent-tool.js";

export type {
  AgentTool,
  AutoLocalAgentToolContract,
} from "./local-agent-tool.js";
