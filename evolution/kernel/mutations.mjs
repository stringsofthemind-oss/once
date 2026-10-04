// Exact, single-occurrence transformations of compiled SDK code. The caller
// must reject zero/multiple matches; never apply these to the production tree.
export const mutations = [
  {id:'unknown-permission',file:'local.js',from:'if (!options.reconcile) {',to:'if (!options.reconcile) { return operation.apply(this, callArgs);'},
  {id:'conflict-bypass',file:'local.js',from:'if (row.fingerprint !== fingerprint) {',to:'if (false && row.fingerprint !== fingerprint) {'},
  {id:'omitted-effect-field',file:'connect/binding.js',from:'const canonical = canonicalizeConnectPayload(payload);',to:'const canonical = canonicalizeConnectPayload(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "currency")));'},
  {id:'restart-state-bypass',file:'local.js',from:'if (!shouldDispatch) {',to:'if (!shouldDispatch && row.state !== "UNKNOWN") {'},
  {id:'absent-redispatch',file:'local.js',from:'if (observation?.state !== "CONFIRMED") {',to:'if (observation?.state === "ABSENT") return operation.apply(this, callArgs);\n                if (observation?.state !== "CONFIRMED") {'},
  {id:'error-fake-success',file:'local.js',from:'throw new LocalProtectionError("UNKNOWN", `ORIGINAL OUTCOME UNKNOWN.',to:'return { fakeSuccess: true }; throw new LocalProtectionError("UNKNOWN", `ORIGINAL OUTCOME UNKNOWN.'},
  {id:'skip-reconcile',file:'local.js',from:'observation = await options.reconcile({ id, payload: copyData(payload) });',to:'observation = {state:"CONFIRMED",result:{fakeSuccess:true}};'},
  {id:'invert-guard',file:'local.js',from:'if (row.state === "CLAIMED" && row.lease_until > Date.now()) {',to:'if (row.state === "CLAIMED" && row.lease_until < Date.now()) {'},
  {id:'skip-receipt-validation',file:'local.js',from:'throw new Error("Malformed receipt envelope.");',to:'return envelope.value;'},
  {id:'missing-truth-accepted',file:'local.js',from:'if (!Object.prototype.hasOwnProperty.call(observation, "result")) {',to:'if (false && !Object.prototype.hasOwnProperty.call(observation, "result")) {'},
];
export default mutations;
