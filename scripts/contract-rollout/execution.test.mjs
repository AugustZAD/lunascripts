import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { executeRollout, resolveStableRingFromHealth } from "./execution.mjs";
import { validateRolloutRecord } from "./core.mjs";
import { applyAuditReport, bindAuditReport } from "./preparation.mjs";

const SHA = "a".repeat(40);
const MERGE = "b".repeat(40);
const BACKEND_MERGE = "c".repeat(40);
const IDE_MERGE = "d".repeat(40);
const CANON_BACKEND = "e".repeat(40);
const CANON_IDE = "f".repeat(40);

function diffEvidence(headSha, files) {
  const sorted = [...files].sort();
  const material = JSON.stringify({ baseBranch: "main", headSha, files: sorted });
  return { baseBranch: "main", files: sorted, digest: `sha256:${createHash("sha256").update(material).digest("hex")}` };
}

function record() {
  const pending = {
    schemaVersion: 1, state: "preparing",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: `sha256:${"1".repeat(64)}` },
    contractVersion: "2.0.0", changeClass: "major",
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: SHA, diffEvidence: diffEvidence(SHA, ["contracts/lunascripts.lock.json"]) },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha: SHA, diffEvidence: diffEvidence(SHA, ["vendor/lunascripts/contract/contract.json"]) },
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
    refreshConsumerPins: async (value, sha) => {
      calls.push(`repin ${sha}`);
      return {
        backend: { ...value.backend, headSha: CANON_BACKEND, diffEvidence: diffEvidence(CANON_BACKEND, value.backend.diffEvidence.files) },
        ide: { ...value.ide, headSha: CANON_IDE, diffEvidence: diffEvidence(CANON_IDE, value.ide.diffEvidence.files) },
        proof: {
          upstreamCandidateHeadSha: value.upstream.headSha,
          approvedTreeDigest: value.upstream.treeDigest,
          canonicalUpstreamSha: sha,
          canonicalTreeDigest: value.upstream.treeDigest,
        },
      };
    },
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
  const persisted = [];
  const result = await executeRollout({
    record: record(),
    confirmed: true,
    actions: successfulActions(calls),
    persist: async (value) => persisted.push(validateRolloutRecord(structuredClone(value))),
  });
  assert.deepEqual(calls, [
    "merge upstream", `repin ${MERGE}`, "checks", "upstream health", "merge backend",
    "resolve ring", "deploy backend", "smoke", "merge ide",
  ]);
  assert.equal(result.state, "complete");
  assert.equal(result.backend.headSha, SHA);
  assert.equal(result.ide.headSha, SHA);
  assert.equal(result.execution.consumerRepin.backend.headSha, CANON_BACKEND);
  assert.equal(result.execution.consumerRepin.ide.headSha, CANON_IDE);
  assert.equal(result.execution.consumerRepin.proof.canonicalTreeDigest, result.upstream.treeDigest);
  assert.equal(persisted.some((value) => value.execution?.stage === "consumers_repinned"), true);
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
  const first = await executeRollout({
    record: record(), confirmed: true, actions,
    persist: async (value) => saved.push(validateRolloutRecord(structuredClone(value))),
  });
  assert.equal(first.state, "rollout_blocked");
  const checkpoint = saved.findLast((value) => value.execution.stage === "consumers_repinned");
  checkpoint.state = "executing";
  const resumedCalls = [];
  const resumed = await executeRollout({ record: checkpoint, confirmed: true, actions: successfulActions(resumedCalls) });
  assert.equal(resumed.state, "complete");
  assert.equal(resumedCalls.includes("merge upstream"), false);
  assert.equal(resumedCalls.some((call) => call.startsWith("repin")), false);
  assert.equal(resumed.execution.consumerRepin.backend.headSha, CANON_BACKEND);
  assert.equal(resumed.backend.headSha, SHA);
});

test("resume converges an IDE-merged final-persist failure to durable complete", async () => {
  const calls = [];
  const saved = [];
  let rejectFinalPersist = true;
  const first = await executeRollout({
    record: record(),
    confirmed: true,
    actions: successfulActions(calls),
    persist: async (value) => {
      saved.push(validateRolloutRecord(structuredClone(value)));
      if (value.state === "complete" && value.execution?.stage === "ide_merged" && rejectFinalPersist) {
        rejectFinalPersist = false;
        throw new Error("comment final persist failed");
      }
    },
  });
  assert.equal(first.state, "rollout_blocked");
  assert.equal(first.execution.stage, "ide_merged");

  const resumedCalls = [];
  const { failure: _failure, ...checkpoint } = first;
  const resumed = await executeRollout({
    record: { ...checkpoint, state: "executing" },
    confirmed: true,
    actions: successfulActions(resumedCalls),
    persist: async (value) => saved.push(validateRolloutRecord(structuredClone(value))),
  });
  assert.equal(resumed.state, "complete");
  assert.equal(resumed.execution.stage, "ide_merged");
  assert.deepEqual(resumedCalls, []);
  assert.equal(saved.at(-1).state, "complete");
});

test("stable ring resolution requires one direct healthy revision match", () => {
  const publicHealth = { data: { revision: SHA } };
  assert.deepEqual(resolveStableRingFromHealth(publicHealth, {
    app072401: { data: { status: "healthy", queueConnectivity: "ok", revision: SHA } },
    app072101: { data: { status: "healthy", queueConnectivity: "ok", revision: MERGE } },
  }), { environment: "app072401", revision: SHA });
  assert.throws(() => resolveStableRingFromHealth(publicHealth, {}), /exactly one/);
});
