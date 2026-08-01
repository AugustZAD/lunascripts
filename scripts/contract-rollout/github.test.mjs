import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLLOUT_COMMENT_MARKER,
  createGitHubClient,
  parsePullRequestUrl,
  parseRolloutComment,
  renderRolloutComment,
} from "./github.mjs";

const SHA = "a".repeat(40);

function fakeRunner(responses = []) {
  const calls = [];
  return {
    calls,
    capture(command, args) {
      calls.push({ kind: "capture", command, args });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return typeof next === "string" ? next : JSON.stringify(next ?? {});
    },
    run(command, args) {
      calls.push({ kind: "run", command, args });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const record = {
  schemaVersion: 1,
  state: "preparing",
  upstream: {
    repository: "cdotlock/lunascripts",
    pullRequest: "https://github.com/cdotlock/lunascripts/pull/2",
    headSha: SHA,
    treeDigest: "sha256:" + "1".repeat(64),
  },
  contractVersion: "2.0.0",
  changeClass: "major",
  backend: {
    repository: "cdotlock/lunaverse-backend",
    pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128",
    headSha: SHA,
  },
  ide: {
    repository: "cdotlock/lunaverse-ide",
    pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15",
    headSha: SHA,
  },
  audit: { status: "pending", blockers: 0, repairRecommended: 0 },
};

test("parses only canonical GitHub pull request URLs", () => {
  assert.deepEqual(parsePullRequestUrl("https://github.com/cdotlock/lunascripts/pull/2"), {
    repository: "cdotlock/lunascripts",
    number: 2,
  });
  assert.throws(() => parsePullRequestUrl("https://example.com/pull/2"), /GitHub pull request/);
});

test("round-trips one marked rollout comment", () => {
  const body = renderRolloutComment(record);
  assert.match(body, new RegExp(ROLLOUT_COMMENT_MARKER));
  assert.deepEqual(parseRolloutComment(body), record);
  assert.equal(parseRolloutComment("ordinary review"), null);
});

test("updates the existing marked comment instead of creating a duplicate", () => {
  const runner = fakeRunner([
    [
      { id: 1, body: "ordinary" },
      { id: 2, body: renderRolloutComment(record) },
    ],
    {},
    [{ id: 2, body: renderRolloutComment({ ...record, state: "needs_fix" }) }],
  ]);
  const github = createGitHubClient(runner);
  github.upsertRolloutComment("cdotlock/lunascripts", 2, { ...record, state: "needs_fix" });
  assert.deepEqual(runner.calls[1].args.slice(0, 4), [
    "api",
    "--method",
    "PATCH",
    "repos/cdotlock/lunascripts/issues/comments/2",
  ]);
  assert.equal(runner.calls.some((call) => call.args.includes("repos/cdotlock/lunascripts/issues/2/comments")), true);
});

test("reads exact PR heads and normalizes checks", () => {
  const runner = fakeRunner([{
    number: 128,
    url: "https://github.com/cdotlock/lunaverse-backend/pull/128",
    state: "OPEN",
    headBranch: null,
    baseBranch: null,
    headRefOid: SHA,
    mergeCommit: null,
    mergeable: "MERGEABLE",
    statusCheckRollup: [
      { __typename: "CheckRun", name: "authority", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://checks/1" },
      { __typename: "StatusContext", context: "lint", state: "PENDING", targetUrl: "https://checks/2" },
    ],
  }]);
  const github = createGitHubClient(runner);
  assert.deepEqual(github.getPullRequest("cdotlock/lunaverse-backend", 128), {
    number: 128,
    url: "https://github.com/cdotlock/lunaverse-backend/pull/128",
    state: "OPEN",
    headBranch: null,
    baseBranch: null,
    headSha: SHA,
    mergeSha: null,
    mergeable: "MERGEABLE",
    checks: [
      { name: "authority", status: "completed", conclusion: "success", url: "https://checks/1" },
      { name: "lint", status: "pending", conclusion: null, url: "https://checks/2" },
    ],
  });
});

test("merge uses expected-head protection and verifies the merged result", () => {
  const mergeSha = "b".repeat(40);
  const runner = fakeRunner([undefined, {
    number: 2,
    url: "https://github.com/cdotlock/lunascripts/pull/2",
    state: "MERGED",
    headRefOid: SHA,
    mergeCommit: { oid: mergeSha },
    mergeable: "UNKNOWN",
    statusCheckRollup: [],
  }]);
  const github = createGitHubClient(runner);
  const result = github.mergePullRequest("cdotlock/lunascripts", 2, SHA, "merge");
  assert.equal(runner.calls[0].args.includes("--match-head-commit"), true);
  assert.equal(runner.calls[0].args.includes(SHA), true);
  assert.equal(result.mergeSha, mergeSha);
});
