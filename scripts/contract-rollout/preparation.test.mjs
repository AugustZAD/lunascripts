import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyAuditReport, bindAuditReport, changedFiles, prepareConsumerWorkspace, prepareRollout, rolloutBranch, verifyConsumerPullRequest } from "./preparation.mjs";

const SHA = "a".repeat(40);
const BACKEND_SHA = "b".repeat(40);
const IDE_SHA = "c".repeat(40);

function preparingRecord() {
  return {
    schemaVersion: 1,
    state: "preparing",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: `sha256:${"1".repeat(64)}` },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: BACKEND_SHA },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha: IDE_SHA },
    audit: { status: "pending", blockers: 0, repairRecommended: 0 },
  };
}

function bootstrapEnvelope(record = preparingRecord(), report = { readOnly: true, blockers: 0, repairRecommended: 34 }) {
  return bindAuditReport(record, report, {
    kind: "bootstrap",
    repository: record.backend.repository,
    revision: record.backend.headSha,
    executable: "scripts/lunascripts-contract-audit.ts",
    sourceReportSha256: `sha256:${"2".repeat(64)}`,
  });
}

test("uses a deterministic consumer branch", () => {
  assert.equal(rolloutBranch("2.0.0", SHA), "contract-rollout/v2.0.0-aaaaaaaa");
});

test("changed files use NUL-delimited porcelain and preserve rename source paths", () => {
  const runner = {
    capture(command, args, options) {
      assert.equal(command, "git");
      assert.deepEqual(args, ["status", "--porcelain=v1", "-z"]);
      assert.equal(options.trim, false);
      return [
        "R  contracts/lunascripts/new name.json",
        "contracts/lunascripts/old name.json",
        " M contracts/lunascripts.lock.json",
        "",
      ].join("\0");
    },
  };
  assert.deepEqual(changedFiles(runner, "/tmp/consumer"), [
    "contracts/lunascripts/new name.json",
    "contracts/lunascripts/old name.json",
    "contracts/lunascripts.lock.json",
  ]);
});

test("changed files fail closed on malformed NUL porcelain", () => {
  const runner = { capture: () => " M contracts/lunascripts.lock.json" };
  assert.throws(() => changedFiles(runner, "/tmp/consumer"), /malformed.*porcelain/i);
});

test("rejects an adopted Backend PR that already contains a committed migration", () => {
  const consumer = {
    key: "backend",
    repository: "cdotlock/lunaverse-backend",
    owned: ["contracts/lunascripts"],
    allowed: ["contracts/lunascripts", "contracts/lunascripts.lock.json"],
  };
  const github = {
    getPullRequest: () => ({ state: "OPEN", baseBranch: "main", headSha: BACKEND_SHA }),
    getPullRequestFiles: () => [
      "contracts/lunascripts/contract.json",
      "prisma/migrations/20260802_unreviewed/migration.sql",
    ],
  };
  assert.throws(
    () => verifyConsumerPullRequest({
      github,
      consumer,
      pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128",
      expectedHeadSha: BACKEND_SHA,
    }),
    /unapproved pull request paths.*prisma\/migrations/,
  );
});

test("prepare rejects an adopted migration before touching its consumer branch", () => {
  const root = mkdtempSync(join(tmpdir(), "rollout-adopt-migration-"));
  mkdirSync(join(root, "contract"));
  writeFileSync(join(root, "contract/contract.json"), JSON.stringify({ contract_version: "2.0.0", change_class: "major" }));
  const calls = [];
  const runner = {
    capture(command, args) {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "rev-parse") return SHA;
      throw new Error("consumer workspace must not be touched");
    },
  };
  const github = {
    getPullRequest(repository, number) {
      if (repository === "cdotlock/lunascripts") return { state: "OPEN", baseBranch: "main", mergeable: "MERGEABLE", headSha: SHA };
      return { number, state: "OPEN", headBranch: "codex/lunascripts-authority", baseBranch: "main", headSha: BACKEND_SHA };
    },
    getPullRequestFiles: () => ["contracts/lunascripts.lock.json", "prisma/migrations/20260802_unreviewed/migration.sql"],
  };
  const consumer = {
    key: "backend", repository: "cdotlock/lunaverse-backend",
    update: () => ["node", ["update"]], verify: [], owned: ["contracts/lunascripts.lock.json"],
    allowed: ["contracts/lunascripts.lock.json"],
  };
  assert.throws(
    () => prepareRollout({
      upstreamUrl: "https://github.com/cdotlock/lunascripts/pull/2", root, runner, github,
      consumers: [consumer], existingPullRequests: { backend: "https://github.com/cdotlock/lunaverse-backend/pull/128" },
    }),
    /unapproved pull request paths.*prisma\/migrations/,
  );
  assert.equal(calls.some((call) => call[0] === "git" && ["clone", "push"].includes(call[1])), false);
});

test("prepare rejects a non-canonical or non-main upstream before consumer writes", () => {
  const root = mkdtempSync(join(tmpdir(), "rollout-upstream-authority-"));
  mkdirSync(join(root, "contract"));
  writeFileSync(join(root, "contract/contract.json"), JSON.stringify({ contract_version: "2.0.0", change_class: "major" }));
  for (const [url, pullRequest, expected] of [
    ["https://github.com/attacker/lunascripts/pull/2", {}, /canonical upstream repository/],
    ["https://github.com/cdotlock/lunascripts/pull/2", {
      url: "https://github.com/cdotlock/lunascripts/pull/2",
      state: "OPEN",
      baseBranch: "release",
      mergeable: "MERGEABLE",
      headSha: SHA,
    }, /base.*main/i],
  ]) {
    const writes = [];
    const runner = { capture: (...args) => { writes.push(args); throw new Error("consumer or local write must not occur"); } };
    const github = {
      getPullRequest: () => pullRequest,
      upsertRolloutComment: () => writes.push("comment"),
    };
    assert.throws(
      () => prepareRollout({ upstreamUrl: url, root, runner, github, consumers: [] }),
      expected,
    );
    assert.deepEqual(writes, []);
  }
});

test("turns a read-only clean audit into one approval gate", () => {
  const record = preparingRecord();
  const updated = applyAuditReport(record, bootstrapEnvelope(record));
  assert.equal(updated.state, "awaiting_approval");
  assert.equal(updated.audit.status, "passed");
  assert.equal(updated.audit.blockers, 0);
  assert.equal(updated.audit.repairRecommended, 34);
  assert.equal(updated.audit.remediation, "manual_review_only");
  assert.equal(updated.audit.provenance.ideHeadSha, IDE_SHA);
});

test("rejects unbound, stale, or forged audit reports before approval", () => {
  const record = preparingRecord();
  assert.throws(
    () => applyAuditReport(record, { readOnly: true, blockers: 0, repairRecommended: 0 }),
    /bound audit envelope/,
  );
  for (const [field, value] of [
    ["upstreamHeadSha", "d".repeat(40)],
    ["backendHeadSha", "d".repeat(40)],
    ["ideHeadSha", "d".repeat(40)],
    ["contractVersion", "3.0.0"],
  ]) {
    const envelope = bootstrapEnvelope(record);
    envelope.provenance[field] = value;
    assert.throws(() => applyAuditReport(record, envelope), new RegExp(field));
  }
  const forged = bootstrapEnvelope(record);
  forged.report.blockers = 1;
  assert.throws(() => applyAuditReport(record, forged), /payload digest/);
});

test("repair recommendations remain review-only and do not block a compatible rollout", () => {
  const record = preparingRecord();
  const updated = applyAuditReport(record, bootstrapEnvelope(record, {
    readOnly: true,
    blockers: 0,
    repairRecommended: 150,
    findings: [{ status: "legacy_repair_recommended" }],
  }));
  assert.equal(updated.state, "awaiting_approval");
  assert.equal(updated.audit.repairRecommended, 150);
  assert.equal(updated.audit.remediation, "manual_review_only");
});

test("updates a deterministic existing consumer PR through its exact-ref adapter", () => {
  const calls = [];
  const consumer = {
    key: "backend",
    repository: "cdotlock/lunaverse-backend",
    install: ["pnpm", ["install", "--frozen-lockfile"]],
    update: (sha) => ["node", ["update.mjs", "--ref", sha, "--json"]],
    verify: [["node", ["--test", "authority.test.mjs"]]],
    owned: ["contracts/lunascripts", "contracts/lunascripts.lock.json"],
    allowed: ["contracts/lunascripts", "contracts/lunascripts.lock.json"],
  };
  const runner = {
    capture(command, args, options = {}) {
      calls.push([command, ...args, options]);
      if (command === "node" && args[0] === "update.mjs") return JSON.stringify({ commit: SHA });
      if (command === "git" && args[0] === "status") return " M contracts/lunascripts/contract.json\0 M contracts/lunascripts.lock.json\0";
      if (command === "git" && args[0] === "rev-parse") return SHA;
      return "";
    },
  };
  let created = false;
  const github = {
    findPullRequestByHead: () => ({ number: 128 }),
    updatePullRequest: (_repo, number, value) => ({ number, url: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: value.expectedHeadSha }),
    getPullRequest: () => ({ baseBranch: "main", headSha: SHA }),
    getPullRequestFiles: () => ["contracts/lunascripts/contract.json", "contracts/lunascripts.lock.json"],
    createPullRequest: () => { created = true; },
  };
  const result = prepareConsumerWorkspace({
    runner, github, consumer, branch: "contract-rollout/v2.0.0-aaaaaaaa", upstreamSha: SHA,
    contractVersion: "2.0.0", upstreamUrl: "https://github.com/cdotlock/lunascripts/pull/2", baseDir: "/tmp",
  });
  assert.equal(result.headSha, SHA);
  assert.equal(created, false);
  assert.equal(result.diffEvidence.baseBranch, "main");
  assert.deepEqual(result.diffEvidence.files, ["contracts/lunascripts.lock.json", "contracts/lunascripts/contract.json"]);
  assert.equal(calls.some((call) => call.join(" ").includes(`update.mjs --ref ${SHA}`)), true);
  assert.equal(calls.some((call) => call[0] === "railway" || call.includes("merge")), false);
  const installIndex = calls.findIndex((call) => call[0] === "pnpm" && call[1] === "install");
  const updateIndex = calls.findIndex((call) => call[0] === "node" && call[1] === "update.mjs");
  assert.ok(installIndex > calls.findIndex((call) => call[0] === "git" && call[1] === "checkout"));
  assert.ok(installIndex < updateIndex);
  assert.deepEqual(calls[installIndex].at(-1), { cwd: "/tmp/backend" });
});

test("dependency install failure stops before commit, push, ready, or rollout comment", () => {
  const root = mkdtempSync(join(tmpdir(), "rollout-install-failure-"));
  mkdirSync(join(root, "contract"));
  writeFileSync(join(root, "contract/contract.json"), JSON.stringify({ contract_version: "2.0.0", change_class: "major" }));
  const externalWrites = [];
  const runner = {
    capture(command, args) {
      if (command === "git" && args[0] === "rev-parse") return SHA;
      if (command === "pnpm" && args[0] === "install") throw new Error("dependency install failed");
      if ((command === "git" && ["commit", "push"].includes(args[0])) || command === "node") externalWrites.push([command, ...args]);
      return "";
    },
  };
  const github = {
    getPullRequest(repository, number) {
      if (repository === "cdotlock/lunascripts") {
        return { state: "OPEN", baseBranch: "main", mergeable: "MERGEABLE", headSha: SHA };
      }
      return { number, state: "OPEN", isDraft: true, headBranch: "codex/lunascripts-authority", baseBranch: "main", headSha: BACKEND_SHA };
    },
    getPullRequestFiles: () => [],
    updatePullRequest: () => externalWrites.push("update PR"),
    createPullRequest: () => externalWrites.push("create PR"),
    markPullRequestReady: () => externalWrites.push("ready PR"),
    upsertRolloutComment: () => externalWrites.push("comment"),
  };
  const consumer = {
    key: "backend",
    repository: "cdotlock/lunaverse-backend",
    install: ["pnpm", ["install", "--frozen-lockfile"]],
    update: () => ["node", ["update"]],
    verify: [],
    owned: [],
    allowed: [],
  };
  assert.throws(
    () => prepareRollout({
      upstreamUrl: "https://github.com/cdotlock/lunascripts/pull/2",
      root,
      runner,
      github,
      consumers: [consumer],
      existingPullRequests: { backend: "https://github.com/cdotlock/lunaverse-backend/pull/128" },
    }),
    /dependency install failed/,
  );
  assert.deepEqual(externalWrites, []);
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
    getPullRequest: () => ({ state: "OPEN", baseBranch: "main", mergeable: "MERGEABLE", headSha: SHA }),
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
  let markedReady = 0;
  const github = {
    getPullRequest(repo, number) {
      if (repo === "cdotlock/lunascripts") return { state: "OPEN", baseBranch: "main", mergeable: "MERGEABLE", headSha: SHA };
      return { number, state: "OPEN", isDraft: true, headBranch: "codex/legacy-authority", baseBranch: "main", headSha: SHA };
    },
    findPullRequestByHead: () => { throw new Error("adopted PR must not be rediscovered by deterministic branch"); },
    updatePullRequest(repo, number, value) { return { number, url: `https://github.com/${repo}/pull/${number}`, headSha: value.expectedHeadSha }; },
    markPullRequestReady() { markedReady++; },
    getPullRequestFiles: () => [],
    createPullRequest: () => { creates++; },
    upsertRolloutComment: () => {},
  };
  const consumer = (key, repository) => ({ key, repository, update: () => ["node", ["update"]], verify: [], owned: [], allowed: [] });
  const result = prepareRollout({
    upstreamUrl: "https://github.com/cdotlock/lunascripts/pull/2", root, runner, github,
    consumers: [consumer("backend", "cdotlock/lunaverse-backend"), consumer("ide", "cdotlock/lunaverse-ide")],
    existingPullRequests: {
      backend: "https://github.com/cdotlock/lunaverse-backend/pull/128",
      ide: "https://github.com/cdotlock/lunaverse-ide/pull/15",
    },
  });
  assert.equal(creates, 0);
  assert.equal(markedReady, 2);
  assert.deepEqual(result.branches, { backend: "codex/legacy-authority", ide: "codex/legacy-authority" });
});
