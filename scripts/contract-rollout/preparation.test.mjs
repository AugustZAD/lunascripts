import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyAuditReport, prepareConsumerWorkspace, prepareRollout, rolloutBranch } from "./preparation.mjs";

const SHA = "a".repeat(40);

test("uses a deterministic consumer branch", () => {
  assert.equal(rolloutBranch("2.0.0", SHA), "contract-rollout/v2.0.0-aaaaaaaa");
});

test("turns a read-only clean audit into one approval gate", () => {
  const record = {
    schemaVersion: 1,
    state: "preparing",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", headSha: SHA, treeDigest: `sha256:${"1".repeat(64)}` },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: SHA },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha: SHA },
    audit: { status: "pending", blockers: 0, repairRecommended: 0 },
  };
  const updated = applyAuditReport(record, { readOnly: true, blockers: 0, repairRecommended: 34 });
  assert.equal(updated.state, "awaiting_approval");
  assert.deepEqual(updated.audit, { status: "passed", blockers: 0, repairRecommended: 34 });
  assert.throws(() => applyAuditReport(record, { readOnly: false, blockers: 0, repairRecommended: 0 }), /read-only/);
});

test("updates a deterministic existing consumer PR through its exact-ref adapter", () => {
  const calls = [];
  const consumer = {
    key: "backend",
    repository: "cdotlock/lunaverse-backend",
    update: (sha) => ["node", ["update.mjs", "--ref", sha, "--json"]],
    verify: [["node", ["--test", "authority.test.mjs"]]],
    owned: ["contracts/lunascripts", "contracts/lunascripts.lock.json"],
  };
  const runner = {
    capture(command, args) {
      calls.push([command, ...args]);
      if (command === "node" && args[0] === "update.mjs") return JSON.stringify({ commit: SHA });
      if (command === "git" && args[0] === "status") return " M contracts/lunascripts/contract.json\n M contracts/lunascripts.lock.json";
      if (command === "git" && args[0] === "rev-parse") return SHA;
      return "";
    },
  };
  let created = false;
  const github = {
    findPullRequestByHead: () => ({ number: 128 }),
    updatePullRequest: (_repo, number, value) => ({ number, url: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: value.expectedHeadSha }),
    createPullRequest: () => { created = true; },
  };
  const result = prepareConsumerWorkspace({
    runner, github, consumer, branch: "contract-rollout/v2.0.0-aaaaaaaa", upstreamSha: SHA,
    contractVersion: "2.0.0", upstreamUrl: "https://github.com/cdotlock/lunascripts/pull/2", baseDir: "/tmp",
  });
  assert.equal(result.headSha, SHA);
  assert.equal(created, false);
  assert.equal(calls.some((call) => call.join(" ").includes(`update.mjs --ref ${SHA}`)), true);
  assert.equal(calls.some((call) => call[0] === "railway" || call.includes("merge")), false);
});

test("permission failures stop with a resumable non-secret handoff", () => {
  const root = mkdtempSync(join(tmpdir(), "rollout-handoff-"));
  mkdirSync(join(root, "contract"));
  writeFileSync(join(root, "contract/contract.json"), JSON.stringify({ contract_version: "2.0.0", change_class: "major" }));
  const runner = {
    capture(command, args) {
      if (command === "git" && args[0] === "rev-parse") return SHA;
      if (command === "git" && args[0] === "push") throw new Error("denied ghp_DO_NOT_LEAK");
      if (command === "node") return "{}";
      if (command === "git" && args[0] === "status") return "";
      return "";
    },
  };
  const github = {
    getPullRequest: () => ({ headSha: SHA }),
    findPullRequestByHead: () => null,
  };
  const consumer = {
    key: "backend", repository: "cdotlock/lunaverse-backend",
    update: (sha) => ["node", ["update", "--ref", sha]], verify: [], owned: ["contracts/lunascripts"],
  };
  assert.throws(
    () => prepareRollout({ upstreamUrl: "https://github.com/cdotlock/lunascripts/pull/2", root, runner, github, consumers: [consumer] }),
    (error) => error.code === "ROLLOUT_HANDOFF" && /rollout prepare/.test(error.message) && !error.message.includes("DO_NOT_LEAK"),
  );
});

test("adopts explicit pre-controller consumer PRs instead of creating duplicates", () => {
  const root = mkdtempSync(join(tmpdir(), "rollout-adopt-"));
  mkdirSync(join(root, "contract"));
  writeFileSync(join(root, "contract/contract.json"), JSON.stringify({ contract_version: "2.0.0", change_class: "major" }));
  const calls = [];
  const runner = {
    capture(command, args) {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "rev-parse") return SHA;
      if (command === "git" && args[0] === "ls-tree") return `100644 blob ${SHA}\tcontract/contract.json`;
      if (command === "git" && args[0] === "status") return "";
      if (command === "node") return "{}";
      return "";
    },
  };
  let creates = 0;
  const github = {
    getPullRequest(repo, number) {
      if (repo === "cdotlock/lunascripts") return { headSha: SHA };
      return { number, state: "OPEN", headBranch: "codex/legacy-authority", headSha: SHA };
    },
    findPullRequestByHead: () => { throw new Error("adopted PR must not be rediscovered by deterministic branch"); },
    updatePullRequest(repo, number, value) { return { number, url: `https://github.com/${repo}/pull/${number}`, headSha: value.expectedHeadSha }; },
    createPullRequest: () => { creates++; },
    upsertRolloutComment: () => {},
  };
  const consumer = (key, repository) => ({ key, repository, update: () => ["node", ["update"]], verify: [], owned: [] });
  const result = prepareRollout({
    upstreamUrl: "https://github.com/cdotlock/lunascripts/pull/2", root, runner, github,
    consumers: [consumer("backend", "cdotlock/lunaverse-backend"), consumer("ide", "cdotlock/lunaverse-ide")],
    existingPullRequests: {
      backend: "https://github.com/cdotlock/lunaverse-backend/pull/128",
      ide: "https://github.com/cdotlock/lunaverse-ide/pull/15",
    },
  });
  assert.equal(creates, 0);
  assert.deepEqual(result.branches, { backend: "codex/legacy-authority", ide: "codex/legacy-authority" });
});
