import assert from "node:assert/strict";
import test from "node:test";

import { syncConsumers } from "./preparation.mjs";

const SHA = "a".repeat(40);
const report = {
  schemaVersion: 2, kind: "consumer-preparation",
  upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", candidateHeadSha: SHA, pinSha: SHA },
  contractVersion: "2.0.0",
  consumers: {
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", branch: "contract-rollout/v2.0.0-aaaaaaaa", headSha: SHA },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", branch: "contract-rollout/v2.0.0-aaaaaaaa", headSha: SHA },
  },
  audit: { status: "pending", blockers: [], repairRecommendations: [], findings: [] },
};

test("sync rejects an unmerged upstream PR before touching consumer workspaces", () => {
  const calls = [];
  const github = { readPreparationReport: () => report, getPullRequest: () => ({ state: "OPEN", baseBranch: "main", headSha: SHA }) };
  assert.throws(() => syncConsumers({
    upstreamUrl: report.upstream.pullRequest, root: "/tmp", github,
    runner: { capture: (...args) => calls.push(args) },
  }), /merged into main/);
  assert.deepEqual(calls, []);
});

test("sync rejects a merge SHA not reachable from main before consumer writes", () => {
  const calls = [];
  const github = {
    readPreparationReport: () => report,
    getPullRequest: () => ({ state: "MERGED", baseBranch: "main", headSha: SHA, mergeSha: "b".repeat(40) }),
    isCommitReachableFromMain: () => false,
  };
  assert.throws(() => syncConsumers({
    upstreamUrl: report.upstream.pullRequest, root: "/tmp", github,
    runner: { capture: (...args) => calls.push(args) },
  }), /reachable/);
  assert.deepEqual(calls, []);
});
