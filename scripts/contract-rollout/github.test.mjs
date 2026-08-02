import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubClient, parsePreparationReport, parsePullRequestUrl, renderFindingComments, renderPreparationReport } from "./github.mjs";

const SHA = "a".repeat(40);
function report() {
  return {
    schemaVersion: 2, kind: "consumer-preparation",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", candidateHeadSha: SHA, pinSha: SHA },
    contractVersion: "2.0.0",
    consumers: {
      backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", branch: "contract-rollout/v2.0.0-aaaaaaaa", headSha: SHA },
      ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", branch: "contract-rollout/v2.0.0-aaaaaaaa", headSha: SHA },
    },
    audit: { status: "pending", blockers: [], repairRecommendations: [], findings: [] },
  };
}

test("canonical PR URLs and preparation comments round trip without executable state", () => {
  assert.deepEqual(parsePullRequestUrl("https://github.com/cdotlock/lunascripts/pull/2"), { repository: "cdotlock/lunascripts", number: 2 });
  assert.throws(() => parsePullRequestUrl("https://github.com/cdotlock/lunascripts/issues/2"), /canonical/);
  assert.deepEqual(parsePreparationReport(renderPreparationReport(report())), report());
});

test("pull request files are slurped across every API page with status and rename metadata", () => {
  const calls = [];
  const runner = {
    capture(command, args) {
      calls.push([command, args]);
      return JSON.stringify([
        [{ filename: "a", status: "modified", sha: "b".repeat(40) }],
        [{ filename: "c", previous_filename: "old", status: "renamed", sha: "d".repeat(40) }],
      ]);
    },
  };
  const files = createGitHubClient(runner).getPullRequestFiles("cdotlock/lunaverse-ide", 15);
  assert.deepEqual(files, [
    { path: "a", previousPath: null, status: "modified", headBlobSha: "b".repeat(40) },
    { path: "c", previousPath: "old", status: "renamed", headBlobSha: "d".repeat(40) },
  ]);
  assert.deepEqual(calls[0][1].slice(-2), ["--paginate", "--slurp"]);
});

test("client surface contains no generic integration or production action", () => {
  const client = createGitHubClient({ capture() { throw new Error("unused"); }, run() { throw new Error("unused"); } });
  assert.equal("mergePullRequest" in client, false);
  assert.equal("dispatchWorkflow" in client, false);
});

test("large sanitized audits round trip through a bounded root and bounded human finding chunks", () => {
  const value = report();
  value.audit = {
    status: "passed", readOnly: true, blockers: [], remediation: "manual_review_only",
    findings: Array.from({ length: 500 }, (_, index) => ({
      novelId: `novel-${index}`, episodeId: `episode-${index}`, status: "legacy_repair_recommended",
      issues: [{ path: "ls_contract_version", message: `recompile and manually review episode ${index}` }],
    })),
    repairRecommendations: Array.from({ length: 500 }, (_, index) => ({ novelId: `novel-${index}`, episodeId: `episode-${index}`, suggestions: [{ path: "ls_contract_version", action: "recompile and manually review" }] })),
    findingsDigest: `sha256:${"f".repeat(64)}`, reportDigest: `sha256:${"e".repeat(64)}`, provenance: {},
  };
  const root = renderPreparationReport(value);
  assert.ok(Buffer.byteLength(root) < 64_000);
  assert.deepEqual(parsePreparationReport(root), value);
  const chunks = renderFindingComments(value);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => Buffer.byteLength(chunk) < 64_000), true);
  assert.match(chunks[0], /novel-0\/episode-0/);
  assert.match(chunks.at(-1), /novel-499\/episode-499/);
});
