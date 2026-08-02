import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "./contractctl.mjs";
import { approvalDigest } from "./contract-rollout/core.mjs";
import { bindAuditReport } from "./contract-rollout/preparation.mjs";

const SHA = "a".repeat(40);

function io() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(String(line)),
    err: (line) => stderr.push(String(line)),
  };
}

function boundAudit({ upstreamSha = SHA, backendSha = SHA, ideSha = SHA, repairRecommended = 0 } = {}) {
  return {
    status: "passed",
    blockers: 0,
    repairRecommended,
    remediation: "manual_review_only",
    reportDigest: `sha256:${"2".repeat(64)}`,
    provenance: {
      upstreamHeadSha: upstreamSha,
      backendHeadSha: backendSha,
      ideHeadSha: ideSha,
      contractVersion: "2.0.0",
      source: {
        kind: "bootstrap",
        repository: "cdotlock/lunaverse-backend",
        revision: backendSha,
        executable: "scripts/lunascripts-contract-audit.ts",
        sourceReportSha256: `sha256:${"3".repeat(64)}`,
      },
    },
  };
}

function diffEvidence(headSha, files) {
  const sorted = [...files].sort();
  const material = JSON.stringify({ baseBranch: "main", headSha, files: sorted });
  return { baseBranch: "main", files: sorted, digest: `sha256:${createHash("sha256").update(material).digest("hex")}` };
}

function backendRef(headSha = SHA) {
  return { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha, diffEvidence: diffEvidence(headSha, ["contracts/lunascripts.lock.json"]) };
}

function ideRef(headSha = SHA) {
  return { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha, diffEvidence: diffEvidence(headSha, ["vendor/lunascripts/contract/contract.json"]) };
}

function filesForRepository(repository) {
  return repository.endsWith("backend") ? backendRef().diffEvidence.files : ideRef().diffEvidence.files;
}

test("continue dry-run is mutation-free and does not require approval", async () => {
  const output = io();
  const calls = [];
  const record = {
    schemaVersion: 1,
    state: "awaiting_approval",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: backendRef(),
    ide: ideRef(),
    audit: boundAudit({ repairRecommended: 34 }),
  };
  const github = {
    readRolloutRecord: () => record,
    getPullRequest: (repo) => {
      calls.push(["read", repo]);
      return { headSha: SHA, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseBranch: "main", checks: [{ status: "completed", conclusion: "success" }] };
    },
    getPullRequestFiles: filesForRepository,
    mergePullRequest: () => calls.push(["mutate"]),
  };
  const code = await main(
    ["rollout", "continue", record.upstream.pullRequest, "--dry-run"],
    { github, io: output },
  );
  assert.equal(code, 0);
  assert.equal(calls.some(([kind]) => kind === "mutate"), false);
  assert.match(output.stdout.join("\n"), /No changes were made/);
});

test("continue refuses real execution without exact confirmation", async () => {
  const output = io();
  const record = {
    schemaVersion: 1,
    state: "awaiting_approval",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: backendRef(),
    ide: ideRef(),
    audit: boundAudit(),
  };
  const code = await main(
    ["rollout", "continue", "https://github.com/cdotlock/lunascripts/pull/2"],
    {
      github: {
        readRolloutRecord: () => record,
        getPullRequest: () => ({ headSha: SHA, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseBranch: "main", checks: [{ status: "completed", conclusion: "success" }] }),
        getPullRequestFiles: filesForRepository,
      },
      io: output,
    },
  );
  assert.equal(code, 2);
  assert.match(output.stderr.join("\n"), /APPROVE_CONTRACT_ROLLOUT/);
});

test("continue blocks draft consumer PRs before the first production-changing action", async () => {
  const output = io();
  const calls = [];
  const record = {
    schemaVersion: 1,
    state: "awaiting_approval",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: backendRef(),
    ide: ideRef(),
    audit: boundAudit(),
  };
  const code = await main(
    ["rollout", "continue", record.upstream.pullRequest, "--confirm", "APPROVE_CONTRACT_ROLLOUT"],
    {
      github: {
        readRolloutRecord: () => record,
        getPullRequest: (repository) => ({
          headSha: SHA,
          state: "OPEN",
          isDraft: repository === "cdotlock/lunaverse-backend",
          mergeable: "MERGEABLE",
          baseBranch: "main",
          checks: [{ status: "completed", conclusion: "success" }],
        }),
        getPullRequestFiles: filesForRepository,
        upsertRolloutComment: () => calls.push("comment"),
      },
      actions: { mergeUpstream: () => calls.push("merge") },
      io: output,
    },
  );
  assert.equal(code, 1);
  assert.match(output.stderr.join("\n"), /draft/i);
  assert.deepEqual(calls, []);
});

test("continue rejects a consumer diff TOCTOU change before any write", async () => {
  const output = io();
  const calls = [];
  const record = {
    schemaVersion: 1,
    state: "awaiting_approval",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: SHA, diffEvidence: diffEvidence(SHA, ["contracts/lunascripts.lock.json"]) },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha: SHA, diffEvidence: diffEvidence(SHA, ["vendor/lunascripts/contract/contract.json"]) },
    audit: boundAudit(),
  };
  const github = {
    readRolloutRecord: () => record,
    getPullRequest: () => ({ headSha: SHA, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseBranch: "main", checks: [{ status: "completed", conclusion: "success" }] }),
    getPullRequestFiles: (repository) => repository.endsWith("backend")
      ? ["contracts/lunascripts.lock.json", "prisma/migrations/20260802_unreviewed/migration.sql"]
      : ["vendor/lunascripts/contract/contract.json"],
    upsertRolloutComment: () => calls.push("comment"),
  };
  const code = await main(
    ["rollout", "continue", record.upstream.pullRequest, "--confirm", "APPROVE_CONTRACT_ROLLOUT"],
    { github, actions: { mergeUpstream: () => calls.push("merge") }, io: output },
  );
  assert.equal(code, 1);
  assert.match(output.stderr.join("\n"), /unapproved pull request paths.*prisma\/migrations/);
  assert.deepEqual(calls, []);
});

test("status, continue, and resume reject a rollout comment copied to a different upstream PR", async () => {
  const originalUrl = "https://github.com/cdotlock/lunascripts/pull/2";
  const copiedContainer = "https://github.com/cdotlock/lunascripts/pull/99";
  const record = {
    schemaVersion: 1,
    state: "awaiting_approval",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: originalUrl, baseBranch: "main", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: SHA, diffEvidence: diffEvidence(SHA, ["contracts/lunascripts.lock.json"]) },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha: SHA, diffEvidence: diffEvidence(SHA, ["vendor/lunascripts/contract/contract.json"]) },
    audit: boundAudit(),
  };
  for (const args of [
    ["rollout", "status", copiedContainer],
    ["rollout", "continue", copiedContainer, "--confirm", "APPROVE_CONTRACT_ROLLOUT"],
    ["rollout", "resume", copiedContainer, "--confirm", "APPROVE_CONTRACT_ROLLOUT_RESUME"],
  ]) {
    const output = io();
    const calls = [];
    const code = await main(args, {
      github: {
        readRolloutRecord: () => record,
        getPullRequest: () => { calls.push("read-pr"); throw new Error("must reject container first"); },
        upsertRolloutComment: () => calls.push("write"),
      },
      actions: { mergeUpstream: () => calls.push("merge") },
      io: output,
    });
    assert.equal(code, 1);
    assert.match(output.stderr.join("\n"), /command URL container/);
    assert.deepEqual(calls, []);
  }
});

test("fresh reload rejects a non-main upstream candidate before merge or persistence", async () => {
  const calls = [];
  const record = {
    schemaVersion: 1,
    state: "awaiting_approval",
    upstream: {
      repository: "cdotlock/lunascripts",
      pullRequest: "https://github.com/cdotlock/lunascripts/pull/2",
      baseBranch: "main",
      headSha: SHA,
      treeDigest: "sha256:" + "1".repeat(64),
    },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: backendRef(),
    ide: ideRef(),
    audit: boundAudit(),
  };
  const output = io();
  const code = await main(
    ["rollout", "continue", record.upstream.pullRequest, "--confirm", "APPROVE_CONTRACT_ROLLOUT"],
    {
      github: {
        readRolloutRecord: () => record,
        getPullRequest: (repository) => {
          calls.push(["read", repository]);
          return {
            url: record.upstream.pullRequest,
            headSha: SHA,
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            baseBranch: repository === "cdotlock/lunascripts" ? "release" : "main",
            checks: [{ status: "completed", conclusion: "success" }],
          };
        },
        getPullRequestFiles: filesForRepository,
        upsertRolloutComment: () => calls.push(["write"]),
      },
      actions: { mergeUpstream: () => calls.push(["merge"]) },
      io: output,
    },
  );
  assert.equal(code, 1);
  assert.match(output.stderr.join("\n"), /base.*main/i);
  assert.equal(calls.some(([kind]) => kind === "write" || kind === "merge"), false);
});

test("continue refuses a durable resume whose stored approval digest is stale", async () => {
  const output = io();
  const calls = [];
  const record = {
    schemaVersion: 1,
    state: "executing",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: backendRef(),
    ide: ideRef(),
    audit: boundAudit(),
    approval: { digest: `sha256:${"9".repeat(64)}`, confirmedAt: new Date().toISOString() },
    execution: { stage: "approved" },
  };
  assert.notEqual(record.approval.digest, approvalDigest(record));
  const code = await main(
    ["rollout", "continue", record.upstream.pullRequest],
    {
      github: {
        readRolloutRecord: () => record,
        getPullRequest: () => ({ headSha: SHA, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseBranch: "main", checks: [{ status: "completed", conclusion: "success" }] }),
        getPullRequestFiles: filesForRepository,
        upsertRolloutComment: () => calls.push("comment"),
      },
      actions: { mergeUpstream: () => calls.push("merge") },
      io: output,
    },
  );
  assert.equal(code, 1);
  assert.match(output.stderr.join("\n"), /approval digest.*does not match/i);
  assert.deepEqual(calls, []);
});

test("resume revalidates a blocked rollout but is read-only without a recovery confirmation", async () => {
  const output = io();
  const calls = [];
  const record = {
    schemaVersion: 1,
    state: "rollout_blocked",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: backendRef(),
    ide: ideRef(),
    audit: boundAudit({ repairRecommended: 150 }),
    execution: { stage: "consumer_checks_green", updatedAt: new Date().toISOString() },
    failure: { stage: "consumer_checks_green", message: "temporary workflow outage" },
  };
  record.approval = { digest: approvalDigest(record), confirmedAt: new Date().toISOString() };
  const code = await main(
    ["rollout", "resume", record.upstream.pullRequest],
    {
      github: {
        readRolloutRecord: () => record,
        getPullRequest: (repository) => {
          calls.push(["read", repository]);
          return { headSha: SHA, state: "OPEN", baseBranch: "main", checks: [{ status: "completed", conclusion: "success" }] };
        },
        getPullRequestFiles: filesForRepository,
        upsertRolloutComment: () => calls.push(["write"]),
      },
      actions: { deployAndVerifyUpstream: () => calls.push(["deploy"]) },
      io: output,
    },
  );
  assert.equal(code, 0);
  assert.match(output.stdout.join("\n"), /--confirm APPROVE_CONTRACT_ROLLOUT_RESUME/);
  assert.equal(calls.filter(([kind]) => kind === "read").length, 5);
  assert.equal(calls.some(([kind]) => kind === "write" || kind === "deploy"), false);
});

test("confirmed blocked recovery resumes only from its durable checkpoint", async () => {
  const calls = [];
  const backendMerge = "b".repeat(40);
  const ideMerge = "c".repeat(40);
  const record = {
    schemaVersion: 1,
    state: "rollout_blocked",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: backendRef(),
    ide: ideRef(),
    audit: boundAudit({ repairRecommended: 150 }),
    execution: { stage: "consumer_checks_green", upstreamMergeSha: SHA, updatedAt: new Date().toISOString() },
    failure: { stage: "consumer_checks_green", message: "temporary workflow outage" },
  };
  record.approval = { digest: approvalDigest(record), confirmedAt: new Date().toISOString() };
  const actions = {
    mergeUpstream: async () => { calls.push("merge upstream"); return { mergeSha: SHA }; },
    refreshConsumerPins: async () => { calls.push("repin"); return { backend: record.backend, ide: record.ide }; },
    waitConsumerChecks: async () => calls.push("checks"),
    deployAndVerifyUpstream: async () => { calls.push("deploy upstream"); return { runId: 7 }; },
    mergeBackend: async () => { calls.push("merge backend"); return { mergeSha: backendMerge }; },
    resolveStableRing: async () => { calls.push("ring"); return { environment: "app072401", revision: SHA }; },
    deployBackend: async () => { calls.push("deploy backend"); return { ok: true, targetBecameActive: true }; },
    verifyProduction: async () => calls.push("smoke"),
    mergeIde: async () => { calls.push("merge ide"); return { mergeSha: ideMerge }; },
  };
  const github = {
    readRolloutRecord: () => record,
    getPullRequest: () => ({ headSha: SHA, state: "OPEN", baseBranch: "main", checks: [{ status: "completed", conclusion: "success" }] }),
    getPullRequestFiles: filesForRepository,
    upsertRolloutComment: (_repo, _number, saved) => calls.push(`comment:${saved.state}:${saved.execution.stage}`),
  };
  const code = await main(
    ["rollout", "resume", record.upstream.pullRequest, "--confirm", "APPROVE_CONTRACT_ROLLOUT_RESUME"],
    { github, actions, io: io() },
  );
  assert.equal(code, 0);
  assert.equal(calls.includes("merge upstream"), false);
  assert.equal(calls.includes("repin"), false);
  assert.equal(calls.includes("checks"), false);
  assert.ok(calls.indexOf("comment:executing:consumer_checks_green") < calls.indexOf("deploy upstream"));
  assert.equal(calls.at(-1), "comment:complete:ide_merged");
});

test("validate detects contract paths and reads the manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "contractctl-validate-"));
  mkdirSync(join(root, "contract"));
  writeFileSync(join(root, "contract/contract.json"), JSON.stringify({
    contract_version: "2.0.0",
    change_class: "major",
    valid_fixtures: "fixtures/valid",
    invalid_fixtures: "fixtures/invalid",
    rollout: {
      consumer_repositories: ["cdotlock/lunaverse-backend", "cdotlock/lunaverse-ide"],
      stored_content_policy: "audit_only",
    },
  }));
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## 2.0.0\n");
  const output = io();
  const runner = {
    capture(command, args) {
      assert.equal(command, "git");
      assert.deepEqual(args.slice(0, 3), ["diff", "--name-only", "base"]);
      return "internal/parser/parser.go\n";
    },
  };
  const code = await main(
    ["rollout", "validate", "--base", "base", "--head", "head"],
    { root, runner, io: output },
  );
  assert.equal(code, 0);
  assert.match(output.stdout.join("\n"), /contract-impacting/);
});

test("prepare can import a verified read-only bootstrap audit without dispatching a workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "contractctl-audit-import-"));
  const report = join(root, "audit.json");
  const output = io();
  const record = {
    schemaVersion: 1, state: "preparing",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0", changeClass: "major",
    backend: backendRef(),
    ide: ideRef(),
    audit: { status: "pending", blockers: 0, repairRecommended: 0 },
  };
  const envelope = bindAuditReport(record, { readOnly: true, blockers: 0, repairRecommended: 7 }, {
    kind: "bootstrap",
    repository: record.backend.repository,
    revision: record.backend.headSha,
    executable: "scripts/lunascripts-contract-audit.ts",
    sourceReportSha256: `sha256:${"2".repeat(64)}`,
  });
  writeFileSync(report, JSON.stringify(envelope));
  let saved;
  const code = await main(
    ["rollout", "prepare", record.upstream.pullRequest, "--audit-report", report],
    {
      root,
      io: output,
      runner: {},
      github: { upsertRolloutComment: (_repo, _number, value) => { saved = value; } },
      prepareRollout: () => ({ branches: { backend: "backend", ide: "ide" }, record }),
    },
  );
  assert.equal(code, 0);
  assert.equal(saved.state, "awaiting_approval");
  assert.equal(saved.audit.status, "passed");
  assert.equal(saved.audit.blockers, 0);
  assert.equal(saved.audit.repairRecommended, 7);
  assert.equal(saved.audit.remediation, "manual_review_only");
});

test("bind-audit creates a head-bound bootstrap envelope after verifying the raw report checksum", async () => {
  const root = mkdtempSync(join(tmpdir(), "contractctl-audit-bind-"));
  mkdirSync(join(root, "contract"));
  writeFileSync(join(root, "contract/contract.json"), JSON.stringify({ contract_version: "2.0.0", change_class: "major" }));
  const report = join(root, "audit.json");
  const output = join(root, "audit.bound.json");
  const raw = `${JSON.stringify({ readOnly: true, blockers: 0, repairRecommended: 150 })}\n`;
  writeFileSync(report, raw);
  const checksum = createHash("sha256").update(raw).digest("hex");
  const heads = {
    "cdotlock/lunascripts": SHA,
    "cdotlock/lunaverse-backend": "b".repeat(40),
    "cdotlock/lunaverse-ide": "c".repeat(40),
  };
  const github = {
    getPullRequest: (repository) => ({ state: "OPEN", headSha: heads[repository] }),
  };
  const runner = { capture: () => SHA };
  const args = [
    "rollout", "bind-audit", "https://github.com/cdotlock/lunascripts/pull/2",
    "--backend-pr", "https://github.com/cdotlock/lunaverse-backend/pull/128",
    "--ide-pr", "https://github.com/cdotlock/lunaverse-ide/pull/15",
    "--upstream-head", heads["cdotlock/lunascripts"],
    "--backend-head", heads["cdotlock/lunaverse-backend"],
    "--ide-head", heads["cdotlock/lunaverse-ide"],
    "--audit-report", report,
    "--report-sha256", checksum,
    "--output", output,
  ];
  const code = await main(args, { root, github, runner, io: io() });
  assert.equal(code, 0);
  const envelope = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(envelope.provenance.upstreamHeadSha, SHA);
  assert.equal(envelope.provenance.backendHeadSha, heads["cdotlock/lunaverse-backend"]);
  assert.equal(envelope.provenance.ideHeadSha, heads["cdotlock/lunaverse-ide"]);
  assert.equal(envelope.provenance.contractVersion, "2.0.0");
  assert.equal(envelope.provenance.source.sourceReportSha256, `sha256:${checksum}`);

  const rejected = join(root, "rejected.bound.json");
  const bad = await main([...args.slice(0, -1), rejected].map((value) => value === checksum ? "0".repeat(64) : value), { root, github, runner, io: io() });
  assert.equal(bad, 1);
  assert.equal(existsSync(rejected), false);

  const stale = join(root, "stale.bound.json");
  const staleArgs = [...args];
  staleArgs[staleArgs.indexOf("--backend-head") + 1] = "d".repeat(40);
  staleArgs[staleArgs.indexOf("--output") + 1] = stale;
  const staleCode = await main(staleArgs, { root, github, runner, io: io() });
  assert.equal(staleCode, 1);
  assert.equal(existsSync(stale), false);
});

test("--help documents audit binding, approval, and blocked recovery with success status", async () => {
  const output = io();
  const code = await main(["--help"], { io: output });
  assert.equal(code, 0);
  const help = output.stdout.join("\n");
  for (const value of [
    "bind-audit",
    "--audit-report",
    "--report-sha256",
    "--backend-pr",
    "--ide-pr",
    "--upstream-head",
    "--backend-head",
    "--ide-head",
    "--confirm APPROVE_CONTRACT_ROLLOUT",
    "--confirm APPROVE_CONTRACT_ROLLOUT_RESUME",
    "repair recommendations",
  ]) assert.match(help, new RegExp(value));
});
