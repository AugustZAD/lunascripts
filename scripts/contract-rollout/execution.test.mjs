import assert from "node:assert/strict";
import test from "node:test";

import { executeRollout, resolveStableRingFromHealth } from "./execution.mjs";
import { applyAuditReport, bindAuditReport } from "./preparation.mjs";

const SHA = "a".repeat(40);
const MERGE = "b".repeat(40);
const BACKEND_MERGE = "c".repeat(40);
const IDE_MERGE = "d".repeat(40);

function record() {
  const pending = {
    schemaVersion: 1, state: "preparing",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", headSha: SHA, treeDigest: `sha256:${"1".repeat(64)}` },
    contractVersion: "2.0.0", changeClass: "major",
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: SHA },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha: SHA },
    audit: { status: "pending", blockers: 0, repairRecommended: 0 },
  };
  const envelope = bindAuditReport(pending, { readOnly: true, blockers: 0, repairRecommended: 34 }, {
    kind: "bootstrap", repository: pending.backend.repository, revision: pending.backend.headSha,
    executable: "scripts/lunascripts-contract-audit.ts", sourceReportSha256: `sha256:${"2".repeat(64)}`,
  });
  return applyAuditReport(pending, envelope);
}

function successfulActions(calls) {
  return {
    mergeUpstream: async () => { calls.push("merge upstream"); return { mergeSha: MERGE }; },
    refreshConsumerPins: async (value, sha) => { calls.push(`repin ${sha}`); return { backend: value.backend, ide: value.ide }; },
    waitConsumerChecks: async () => calls.push("checks"),
    deployAndVerifyUpstream: async () => { calls.push("upstream health"); return { runId: 1 }; },
    mergeBackend: async () => { calls.push("merge backend"); return { mergeSha: BACKEND_MERGE }; },
    resolveStableRing: async () => { calls.push("resolve ring"); return { environment: "app072401", revision: SHA }; },
    deployBackend: async () => { calls.push("deploy backend"); return { ok: true, targetBecameActive: true }; },
    verifyProduction: async () => calls.push("smoke"),
    mergeIde: async () => { calls.push("merge ide"); return { mergeSha: IDE_MERGE }; },
  };
}

test("executes the exact approved dependency order and never dispatches an IDE release", async () => {
  const calls = [];
  const result = await executeRollout({ record: record(), confirmed: true, actions: successfulActions(calls) });
  assert.deepEqual(calls, [
    "merge upstream", `repin ${MERGE}`, "checks", "upstream health", "merge backend",
    "resolve ring", "deploy backend", "smoke", "merge ide",
  ]);
  assert.equal(result.state, "complete");
  assert.equal(calls.some((call) => call.includes("release")), false);
});

test("refuses all action without the initiating operator confirmation", async () => {
  const calls = [];
  await assert.rejects(() => executeRollout({ record: record(), confirmed: false, actions: successfulActions(calls) }), /confirmation/);
  assert.deepEqual(calls, []);
});

test("pauses without rollback before traffic and records verified rollback after traffic", async () => {
  for (const [deployment, expected] of [
    [{ ok: false, targetBecameActive: false, rollbackVerified: false }, "rollout_blocked"],
    [{ ok: false, targetBecameActive: true, rollbackVerified: true }, "rolled_back"],
  ]) {
    const calls = [];
    const actions = successfulActions(calls);
    actions.deployBackend = async () => deployment;
    actions.mergeIde = async () => { throw new Error("IDE must not merge"); };
    const result = await executeRollout({ record: record(), confirmed: true, actions });
    assert.equal(result.state, expected);
    assert.equal(calls.includes("smoke"), false);
  }
});

test("resumes after a durable stage without repeating completed mutations", async () => {
  const calls = [];
  const saved = [];
  const actions = successfulActions(calls);
  actions.waitConsumerChecks = async () => { calls.push("checks"); throw new Error("temporary CI outage"); };
  const first = await executeRollout({ record: record(), confirmed: true, actions, persist: async (value) => saved.push(structuredClone(value)) });
  assert.equal(first.state, "rollout_blocked");
  const checkpoint = saved.findLast((value) => value.execution.stage === "consumers_repinned");
  checkpoint.state = "executing";
  const resumedCalls = [];
  const resumed = await executeRollout({ record: checkpoint, confirmed: true, actions: successfulActions(resumedCalls) });
  assert.equal(resumed.state, "complete");
  assert.equal(resumedCalls.includes("merge upstream"), false);
  assert.equal(resumedCalls.some((call) => call.startsWith("repin")), false);
});

test("stable ring resolution requires one direct healthy revision match", () => {
  const publicHealth = { data: { revision: SHA } };
  assert.deepEqual(resolveStableRingFromHealth(publicHealth, {
    app072401: { data: { status: "healthy", queueConnectivity: "ok", revision: SHA } },
    app072101: { data: { status: "healthy", queueConnectivity: "ok", revision: MERGE } },
  }), { environment: "app072401", revision: SHA });
  assert.throws(() => resolveStableRingFromHealth(publicHealth, {}), /exactly one/);
});
