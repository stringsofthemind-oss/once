/** Trusted receipt format. Evaluation evidence stays JSON data, never code. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface Evidence { [key: string]: JsonValue }
export interface EvaluationResults {
  ordinary: Evidence;
  property: Evidence;
  stateMachine: Evidence;
  mutation: Evidence;
  holdout: Evidence;
  adversarial: Evidence;
  coldUser: Evidence;
  performance: Evidence;
  security: Evidence;
  evaluatorTampering: Evidence;
}
export interface EvolutionReceipt {
  schemaVersion: 1;
  campaignId: string;
  candidateId: string;
  parentCandidate: string | null;
  generation: number;
  baselineCommit: string | null;
  candidateCommit: string | null;
  riskRing: 0 | 1 | 2 | 3 | 4;
  constitution: Evidence;
  evaluator: Evidence;
  roles: Evidence;
  target: string | Evidence;
  hypothesis: string;
  filesChanged: string[];
  diffStatistics: Evidence;
  results: EvaluationResults;
  hardGates: {kernelIntegrity: boolean; protectedPaths: boolean; ordinary: boolean; properties: boolean; stateMachine: boolean; holdout: boolean; adversarial: boolean; mutation: boolean; documentation: boolean; noCandidateExecution: boolean; noCredentials: boolean; noSelfApproval: boolean; cleanReproduction: boolean; resourceLimits: boolean;};
  softMetrics: Evidence;
  decision: 'REJECTED' | 'INELIGIBLE' | 'ELIGIBLE_FOR_HUMAN_PROMOTION';
  decisionReason: string;
  promotionEligibility: boolean;
  rollback: Evidence;
  timestamps: Evidence;
  environment: Evidence;
  cleanReproduction: Evidence | boolean;
  provenance: Evidence;
  /** SHA-256 over canonical receipt contents excluding this field. */
  receiptHash: string;
}
