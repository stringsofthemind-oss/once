import assert from "node:assert/strict";
import { currentOnboardingSurfaces, validateCurrentOnboarding } from "./check-current-onboarding.mjs";

const original = currentOnboardingSurfaces();
validateCurrentOnboarding(original);
for (const name of ["rootReadme", "sdkReadme", "agentGuide", "llms", "html", "start", "recovery"]) {
  const stale = { ...original, [name]: original[name].replaceAll(original.version, "0.0.0") };
  assert.throws(() => validateCurrentOnboarding(stale), undefined, `${name} drift must fail`);
}
assert.throws(() => validateCurrentOnboarding({ ...original, mcpDependency: "0.0.0" }));
for (const name of ["rootReadme", "sdkReadme", "html"]) {
  assert.throws(() => validateCurrentOnboarding({ ...original, [name]: original[name] + "\nRun 60s quickstart" }));
}
validateCurrentOnboarding({ ...original, rootReadme: original.rootReadme + "\nHistorical lab: @once-agent/sdk@0.1.9" });
console.log("Current onboarding regressions: 13 checks passed");
