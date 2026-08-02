import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ROLLOUT_COMMENT_MARKER,
  createGitHubClient,
  parsePullRequestUrl,
  parseRolloutComment,
  renderRolloutComment,
} from "./github.mjs";
import { applyAuditReport, bindAuditReport } from "./preparation.mjs";

const SHA = "a".repeat(40);

function diffEvidence(headSha, files) {
  const sorted = [...files].sort();
  const material = JSON.stringify({ baseBranch: "main", headSha, files: sorted });
  return { baseBranch: "main", files: sorted, digest: `sha256:${createHash("sha256").update(material).digest("hex")}` };
}

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
    diffEvidence: diffEvidence(SHA, ["contracts/lunascripts.lock.json"]),
  },
  ide: {
    repository: "cdotlock/lunaverse-ide",
    pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15",
    headSha: SHA,
    diffEvidence: diffEvidence(SHA, ["vendor/lunascripts/contract/contract.json"]),
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

test("rollout comment makes repair recommendations explicitly manual", () => {
  const envelope = bindAuditReport(record, { readOnly: true, blockers: 0, repairRecommended: 150 }, {
    kind: "bootstrap",
    repository: record.backend.repository,
    revision: record.backend.headSha,
    executable: "scripts/lunascripts-contract-audit.ts",
    sourceReportSha256: `sha256:${"2".repeat(64)}`,
  });
  const body = renderRolloutComment(applyAuditReport(record, envelope));
  assert.match(body, /150 repair recommendation\(s\)/);
  assert.match(body, /manual review only/i);
  assert.match(body, /never modifies stored content/i);
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
    isDraft: false,
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
    isDraft: false,
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

test("resolves the canonical tree digest from an exact commit", () => {
  const treeSha = "d".repeat(40);
  const runner = fakeRunner([{ tree: { sha: treeSha } }]);
  const github = createGitHubClient(runner);
  assert.equal(
    github.getTreeDigest("cdotlock/lunascripts", SHA),
    `sha256:${createHash("sha256").update(treeSha).digest("hex")}`,
  );
  assert.deepEqual(runner.calls[0].args, ["api", `repos/cdotlock/lunascripts/git/commits/${SHA}`]);
});

test("marks an adopted draft ready without changing its expected head", () => {
  const draft = {
    number: 128,
    url: "https://github.com/cdotlock/lunaverse-backend/pull/128",
    state: "OPEN",
    isDraft: true,
    headRefOid: SHA,
    mergeable: "MERGEABLE",
    statusCheckRollup: [],
  };
  const runner = fakeRunner([draft, undefined, { ...draft, isDraft: false }]);
  const github = createGitHubClient(runner);
  github.markPullRequestReady("cdotlock/lunaverse-backend", 128, SHA);
  assert.deepEqual(runner.calls[1].args, ["pr", "ready", "128", "--repo", "cdotlock/lunaverse-backend"]);
});

test("reads the complete pull request path set including rename sources", () => {
  const runner = fakeRunner([[
    { filename: "contracts/lunascripts/contract.json", status: "modified" },
    { filename: "contracts/lunascripts/new.json", previous_filename: "prisma/migrations/old.sql", status: "renamed" },
  ]]);
  const github = createGitHubClient(runner);
  assert.deepEqual(github.getPullRequestFiles("cdotlock/lunaverse-backend", 128), [
    "contracts/lunascripts/contract.json",
    "contracts/lunascripts/new.json",
    "prisma/migrations/old.sql",
  ]);
  assert.deepEqual(runner.calls[0].args, ["api", "repos/cdotlock/lunaverse-backend/pulls/128/files", "--paginate"]);
});
