import type { CustomTrainingAgentPayload } from "./trainingRequestTypes";
import { toObjectOrEmpty, toTextOrEmpty } from "./trainingBuildUtils";

export function buildTrainingAgent(input: {
  configValues: Record<string, unknown>;
}): CustomTrainingAgentPayload {
  const policy = toObjectOrEmpty(input.configValues.policy);
  const policyRules = toObjectOrEmpty(input.configValues.policyRules);
  return {
    agentId: toTextOrEmpty(input.configValues.agentId) || undefined,
    trainer: toTextOrEmpty(policy.trainer) || undefined,
    algorithm: toTextOrEmpty(policy.algorithm) || undefined,
    preset: toTextOrEmpty(policy.preset) || undefined,
    policy: Object.keys(policy).length > 0 ? policy : undefined,
    policyRules: Object.keys(policyRules).length > 0 ? policyRules : undefined,
    metadata: toObjectOrEmpty(input.configValues.agent),
  };
}
