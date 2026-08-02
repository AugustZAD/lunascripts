import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalRepinProof, createExecutionActions } from "./runtime.mjs";

const SHA = "a".repeat(40);

test("canonical repin proof preserves the immutable approved candidate", () => {
  const record = { upstream: { headSha: "b".repeat(40), treeDigest: `sha256:${"1".repeat(64)}` } };
  assert.deepEqual(createCanonicalRepinProof(record, SHA, record.upstream.treeDigest), {
    upstreamCandidateHeadSha: record.upstream.headSha,
    approvedTreeDigest: record.upstream.treeDigest,
    canonicalUpstreamSha: SHA,
    canonicalTreeDigest: record.upstream.treeDigest,
  });
  assert.throws(
    () => createCanonicalRepinProof(record, SHA, `sha256:${"9".repeat(64)}`),
    /approved tree digest/,
  );
});

test("canonical upstream tree must match the approved tree before consumer repins", async () => {
  const runnerCalls = [];
  const github = {
    getBranchSha: () => SHA,
    getTreeDigest: () => `sha256:${"9".repeat(64)}`,
  };
  const runner = {
    capture: (...args) => {
      runnerCalls.push(args);
      throw new Error("consumer workspace must not be touched before tree verification");
    },
  };
  const actions = createExecutionActions({ github, runner, fetchFn: async () => { throw new Error("unexpected fetch"); } });
  const record = {
    upstream: { treeDigest: `sha256:${"1".repeat(64)}` },
    backend: {},
    ide: {},
  };
  await assert.rejects(
    () => actions.refreshConsumerPins(record, SHA),
    /canonical upstream tree does not match the approved tree digest/,
  );
  assert.deepEqual(runnerCalls, []);
});

test("upstream production deploy is an exact approved controller dispatch", async () => {
  const calls = [];
  const github = {
    dispatchWorkflow: (...args) => calls.push(args),
    waitForWorkflowRun: () => ({ databaseId: 77 }),
    watchWorkflowRun: () => ({ conclusion: "success", url: "https://github.test/run/77" }),
  };
  const actions = createExecutionActions({
    github,
    runner: {},
    fetchFn: async () => ({ ok: true, json: async () => ({ status: "ok", revision: SHA }) }),
  });
  await actions.deployAndVerifyUpstream(SHA);
  assert.deepEqual(calls, [[
    "cdotlock/lunascripts",
    "deploy-railway.yml",
    "main",
    { confirm: "DEPLOY_APPROVED_CONTRACT_ROLLOUT", revision: SHA },
  ]]);
});
