import assert from "node:assert/strict";
import test from "node:test";

import { main } from "./contractctl.mjs";

function io() {
  const out = [];
  const err = [];
  return { out, err, value: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

test("help exposes only validation, consumer preparation/sync, and read-only status", async () => {
  const sink = io();
  assert.equal(await main(["--help"], { io: sink.value, runner: {}, github: {} }), 0);
  const text = sink.out.join("\n");
  assert.match(text, /consumers <prepare\|sync>/);
  assert.match(text, /status/);
  assert.doesNotMatch(text, /merge|deploy|continue|resume|confirm/i);
});

test("removed controller actions are unknown and perform no calls", async () => {
  const sink = io();
  const calls = [];
  const runner = new Proxy({}, { get: () => (...args) => calls.push(args) });
  assert.equal(await main(["rollout", "continue", "https://github.com/cdotlock/lunascripts/pull/2"], { io: sink.value, runner, github: {} }), 1);
  assert.deepEqual(calls, []);
  assert.match(sink.err[0], /unknown/);
});

test("status rejects a report whose adopted branch no longer matches the exact PR head branch", async () => {
  const sink = io();
  const sha = "a".repeat(40);
  const report = {
    schemaVersion: 2, kind: "consumer-preparation",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", candidateHeadSha: sha, pinSha: sha },
    contractVersion: "2.0.0",
    consumers: {
      backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", branch: "codex/lunascripts-authority", headSha: sha, diffEvidence: { baseSha: sha, remoteFiles: [] } },
      ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", branch: "codex/lunascripts-authority", headSha: sha, diffEvidence: { baseSha: sha, remoteFiles: [] } },
    },
    audit: { status: "pending", blockers: [], repairRecommendations: [], findings: [] },
  };
  const github = {
    readPreparationReport: () => report,
    getPullRequest: (repository) => repository === "cdotlock/lunascripts"
      ? { state: "OPEN", baseBranch: "main", headSha: sha }
      : { state: "OPEN", baseBranch: "main", baseSha: sha, headSha: sha, headBranch: "codex/other" },
    getPullRequestFiles: () => [],
  };
  assert.equal(await main(["rollout", "status", "https://github.com/cdotlock/lunascripts/pull/2", "--json"], { io: sink.value, runner: {}, github }), 1);
  assert.match(sink.err[0], /branch|identity/i);
});
