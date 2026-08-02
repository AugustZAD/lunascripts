import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createCanonicalRepinProof, createExecutionActions } from "./runtime.mjs";

const SHA = "a".repeat(40);

function diffEvidence(headSha, files) {
  const sorted = [...files].sort();
  const material = JSON.stringify({ baseBranch: "main", headSha, files: sorted });
  return { baseBranch: "main", files: sorted, digest: `sha256:${createHash("sha256").update(material).digest("hex")}` };
}

function approvedRecord() {
  return {
    upstream: {
      repository: "cdotlock/lunascripts",
      pullRequest: "https://github.com/cdotlock/lunascripts/pull/2",
      baseBranch: "main",
      headSha: "b".repeat(40),
      treeDigest: `sha256:${"1".repeat(64)}`,
    },
    contractVersion: "2.0.0",
    backend: {
      repository: "cdotlock/lunaverse-backend",
      pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128",
      headSha: "c".repeat(40),
      diffEvidence: diffEvidence("c".repeat(40), ["contracts/lunascripts.lock.json"]),
    },
    ide: {
      repository: "cdotlock/lunaverse-ide",
      pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15",
      headSha: "d".repeat(40),
      diffEvidence: diffEvidence("d".repeat(40), ["vendor/lunascripts"]),
    },
  };
}

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

test("canonical repin preflights every approved consumer before touching a workspace", async () => {
  const record = approvedRecord();
  const runnerCalls = [];
  const github = {
    getBranchSha: () => SHA,
    getTreeDigest: () => record.upstream.treeDigest,
    getPullRequest: (repository, number) => ({
      number,
      url: repository === record.backend.repository ? record.backend.pullRequest : record.ide.pullRequest,
      state: "OPEN",
      headBranch: `contract-rollout/v2.0.0-${repository === record.backend.repository ? "cccccccc" : "dddddddd"}`,
      baseBranch: "main",
      headSha: repository === record.backend.repository ? record.backend.headSha : "e".repeat(40),
    }),
    getPullRequestFiles: (repository) => repository === record.backend.repository
      ? record.backend.diffEvidence.files
      : record.ide.diffEvidence.files,
  };
  const runner = { capture: (...args) => { runnerCalls.push(args); throw new Error("consumer workspace must not be touched"); } };
  const actions = createExecutionActions({ github, runner, fetchFn: async () => { throw new Error("unexpected fetch"); } });

  await assert.rejects(() => actions.refreshConsumerPins(record, SHA), /head.*approved|head changed/i);
  assert.deepEqual(runnerCalls, []);
});

test("canonical repin rejects a fetched branch drift before updater or remote writes", async () => {
  const record = approvedRecord();
  const externalWrites = [];
  const github = {
    getBranchSha: () => SHA,
    getTreeDigest: () => record.upstream.treeDigest,
    getPullRequest: (repository, number) => {
      const approved = repository === record.backend.repository ? record.backend : record.ide;
      return {
        number,
        url: approved.pullRequest,
        state: "OPEN",
        headBranch: `contract-rollout/v2.0.0-${approved.headSha.slice(0, 8)}`,
        baseBranch: "main",
        headSha: approved.headSha,
      };
    },
    getPullRequestFiles: (repository) => repository === record.backend.repository
      ? record.backend.diffEvidence.files
      : record.ide.diffEvidence.files,
    findPullRequestByHead: () => ({ number: 128, headSha: record.backend.headSha }),
    updatePullRequest: () => externalWrites.push("update PR"),
    createPullRequest: () => externalWrites.push("create PR"),
    markPullRequestReady: () => externalWrites.push("ready PR"),
  };
  const runner = {
    capture(command, args) {
      if (command === "git" && ["clone", "fetch", "checkout", "merge-base"].includes(args[0])) return "";
      if (command === "git" && args[0] === "rev-parse") return "e".repeat(40);
      if (command === "git" && args[0] === "push") externalWrites.push("push");
      if (command !== "git") externalWrites.push("updater");
      throw new Error("updater or remote write occurred before fetched-head validation");
    },
  };
  const actions = createExecutionActions({ github, runner, fetchFn: async () => { throw new Error("unexpected fetch"); } });

  await assert.rejects(() => actions.refreshConsumerPins(record, SHA), /checked out head.*approved|fetched.*head/i);
  assert.deepEqual(externalWrites, []);
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
    SHA,
    { confirm: "DEPLOY_APPROVED_CONTRACT_ROLLOUT", revision: SHA },
  ]]);
});
